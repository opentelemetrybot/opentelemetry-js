/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  PerformanceEntries,
  PerformanceResourceTimingInfo,
  PropagateTraceHeaderCorsUrls,
} from './types';
import { PerformanceTimingNames as PTN } from './enums/PerformanceTimingNames';
import * as api from '@opentelemetry/api';
import {
  hrTimeToNanoseconds,
  timeInputToHrTime,
  urlMatches,
} from '@opentelemetry/core';
import {
  ATTR_HTTP_RESPONSE_CONTENT_LENGTH,
  ATTR_HTTP_RESPONSE_CONTENT_LENGTH_UNCOMPRESSED,
} from './semconv';

// Used to normalize relative URLs
let urlNormalizingAnchor: HTMLAnchorElement | undefined;
function getUrlNormalizingAnchor(): HTMLAnchorElement {
  if (!urlNormalizingAnchor) {
    urlNormalizingAnchor = document.createElement('a');
  }

  return urlNormalizingAnchor;
}

/**
 * Helper function to be able to use enum as typed key in type and in interface when using forEach
 * @param obj
 * @param key
 */
export function hasKey<O extends object>(
  obj: O,
  key: PropertyKey
): key is keyof O {
  return key in obj;
}

/**
 * Helper function for starting an event on span based on {@link PerformanceEntries}
 * @param span
 * @param performanceName name of performance entry for time start
 * @param entries
 * @param ignoreZeros
 */
export function addSpanNetworkEvent(
  span: api.Span,
  performanceName: string,
  entries: PerformanceEntries,
  ignoreZeros = true
): api.Span | undefined {
  if (
    hasKey(entries, performanceName) &&
    typeof entries[performanceName] === 'number' &&
    !(ignoreZeros && entries[performanceName] === 0)
  ) {
    return span.addEvent(performanceName, entries[performanceName]);
  }

  return undefined;
}

/**
 * Helper function for adding network events and content length attributes.
 */
export function addSpanNetworkEvents(
  span: api.Span,
  resource: PerformanceEntries,
  ignoreNetworkEvents = false,
  ignoreZeros?: boolean,
  skipOldSemconvContentLengthAttrs?: boolean
): void {
  if (ignoreZeros === undefined) {
    ignoreZeros = resource[PTN.START_TIME] !== 0;
  }

  if (!ignoreNetworkEvents) {
    addSpanNetworkEvent(span, PTN.FETCH_START, resource, ignoreZeros);
    addSpanNetworkEvent(span, PTN.DOMAIN_LOOKUP_START, resource, ignoreZeros);
    addSpanNetworkEvent(span, PTN.DOMAIN_LOOKUP_END, resource, ignoreZeros);
    addSpanNetworkEvent(span, PTN.CONNECT_START, resource, ignoreZeros);
    addSpanNetworkEvent(
      span,
      PTN.SECURE_CONNECTION_START,
      resource,
      ignoreZeros
    );
    addSpanNetworkEvent(span, PTN.CONNECT_END, resource, ignoreZeros);
    addSpanNetworkEvent(span, PTN.REQUEST_START, resource, ignoreZeros);
    addSpanNetworkEvent(span, PTN.RESPONSE_START, resource, ignoreZeros);
    addSpanNetworkEvent(span, PTN.RESPONSE_END, resource, ignoreZeros);
  }

  if (!skipOldSemconvContentLengthAttrs) {
    // This block adds content-length-related span attributes using the
    // *old* HTTP semconv (v1.7.0).
    const encodedLength = resource[PTN.ENCODED_BODY_SIZE];
    if (encodedLength !== undefined) {
      span.setAttribute(ATTR_HTTP_RESPONSE_CONTENT_LENGTH, encodedLength);
    }

    const decodedLength = resource[PTN.DECODED_BODY_SIZE];
    // Spec: Not set if transport encoding not used (in which case encoded and decoded sizes match)
    if (decodedLength !== undefined && encodedLength !== decodedLength) {
      span.setAttribute(
        ATTR_HTTP_RESPONSE_CONTENT_LENGTH_UNCOMPRESSED,
        decodedLength
      );
    }
  }
}

/**
 * sort resources by startTime
 * @param filteredResources
 */
export function sortResources(
  filteredResources: PerformanceResourceTiming[]
): PerformanceResourceTiming[] {
  return filteredResources.slice().sort((a, b) => {
    const valueA = a[PTN.FETCH_START];
    const valueB = b[PTN.FETCH_START];
    if (valueA > valueB) {
      return 1;
    } else if (valueA < valueB) {
      return -1;
    }
    return 0;
  });
}

/** Returns the origin if present (if in browser context). */
function getOrigin(): string | undefined {
  return typeof location !== 'undefined' ? location.origin : undefined;
}

/**
 * Get closest performance resource ignoring the resources that have been
 * already used.
 * @param spanUrl
 * @param startTimeHR
 * @param endTimeHR
 * @param resources
 * @param ignoredResources
 * @param initiatorType
 */
export function getResource(
  spanUrl: string,
  startTimeHR: api.HrTime,
  endTimeHR: api.HrTime,
  resources: PerformanceResourceTiming[],
  ignoredResources: WeakSet<PerformanceResourceTiming> = new WeakSet<PerformanceResourceTiming>(),
  initiatorType?: string
): PerformanceResourceTimingInfo {
  // de-relativize the URL before usage (does no harm to absolute URLs)
  const parsedSpanUrl = parseUrl(spanUrl);
  spanUrl = parsedSpanUrl.toString();

  const filteredResources = filterResourcesForSpan(
    spanUrl,
    startTimeHR,
    endTimeHR,
    resources,
    ignoredResources,
    initiatorType
  );

  if (filteredResources.length === 0) {
    return {
      mainRequest: undefined,
    };
  }
  if (filteredResources.length === 1) {
    return {
      mainRequest: filteredResources[0],
    };
  }
  const sorted = sortResources(filteredResources);

  if (parsedSpanUrl.origin !== getOrigin() && sorted.length > 1) {
    let corsPreFlightRequest: PerformanceResourceTiming | undefined = sorted[0];
    let mainRequest: PerformanceResourceTiming = findMainRequest(
      sorted,
      corsPreFlightRequest[PTN.RESPONSE_END],
      endTimeHR
    );

    const responseEnd = corsPreFlightRequest[PTN.RESPONSE_END];
    const fetchStart = mainRequest[PTN.FETCH_START];

    // no corsPreFlightRequest
    if (fetchStart < responseEnd) {
      mainRequest = corsPreFlightRequest;
      corsPreFlightRequest = undefined;
    }

    return {
      corsPreFlightRequest,
      mainRequest,
    };
  } else {
    return {
      mainRequest: filteredResources[0],
    };
  }
}

/**
 * Will find the main request skipping the cors pre flight requests
 * @param resources
 * @param corsPreFlightRequestEndTime
 * @param spanEndTimeHR
 */
function findMainRequest(
  resources: PerformanceResourceTiming[],
  corsPreFlightRequestEndTime: number,
  spanEndTimeHR: api.HrTime
): PerformanceResourceTiming {
  const spanEndTime = hrTimeToNanoseconds(spanEndTimeHR);
  const minTime = hrTimeToNanoseconds(
    timeInputToHrTime(corsPreFlightRequestEndTime)
  );

  let mainRequest: PerformanceResourceTiming = resources[1];
  let bestGap;

  const length = resources.length;
  for (let i = 1; i < length; i++) {
    const resource = resources[i];
    const resourceStartTime = hrTimeToNanoseconds(
      timeInputToHrTime(resource[PTN.FETCH_START])
    );

    const resourceEndTime = hrTimeToNanoseconds(
      timeInputToHrTime(resource[PTN.RESPONSE_END])
    );

    const currentGap = spanEndTime - resourceEndTime;

    if (resourceStartTime >= minTime && (!bestGap || currentGap < bestGap)) {
      bestGap = currentGap;
      mainRequest = resource;
    }
  }
  return mainRequest;
}

/**
 * Filter all resources that has started and finished according to span start time and end time.
 *     It will return the closest resource to a start time
 * @param spanUrl
 * @param startTimeHR
 * @param endTimeHR
 * @param resources
 * @param ignoredResources
 */
function filterResourcesForSpan(
  spanUrl: string,
  startTimeHR: api.HrTime,
  endTimeHR: api.HrTime,
  resources: PerformanceResourceTiming[],
  ignoredResources: WeakSet<PerformanceResourceTiming>,
  initiatorType?: string
) {
  const startTime = hrTimeToNanoseconds(startTimeHR);
  const endTime = hrTimeToNanoseconds(endTimeHR);
  let filteredResources = resources.filter(resource => {
    const resourceStartTime = hrTimeToNanoseconds(
      timeInputToHrTime(resource[PTN.FETCH_START])
    );
    const resourceEndTime = hrTimeToNanoseconds(
      timeInputToHrTime(resource[PTN.RESPONSE_END])
    );

    return (
      resource.initiatorType.toLowerCase() ===
        (initiatorType || 'xmlhttprequest') &&
      resource.name === spanUrl &&
      resourceStartTime >= startTime &&
      resourceEndTime <= endTime
    );
  });

  if (filteredResources.length > 0) {
    filteredResources = filteredResources.filter(resource => {
      return !ignoredResources.has(resource);
    });
  }

  return filteredResources;
}

/**
 * The URLLike interface represents an URL and HTMLAnchorElement compatible fields.
 */
export interface URLLike {
  hash: string;
  host: string;
  hostname: string;
  href: string;
  readonly origin: string;
  password: string;
  pathname: string;
  port: string;
  protocol: string;
  search: string;
  username: string;
}

/**
 * Parses url using URL constructor or fallback to anchor element.
 * @param url
 */
export function parseUrl(url: string): URLLike {
  if (typeof URL === 'function') {
    return new URL(
      url,
      typeof document !== 'undefined'
        ? document.baseURI
        : typeof location !== 'undefined' // Some JS runtimes (e.g. Deno) don't define this
          ? location.href
          : undefined
    );
  }
  const element = getUrlNormalizingAnchor();
  element.href = url;
  return element;
}

/**
 * Parses url using URL constructor or fallback to anchor element and serialize
 * it to a string.
 *
 * Performs the steps described in https://html.spec.whatwg.org/multipage/urls-and-fetching.html#parse-a-url
 *
 * @param url
 */
export function normalizeUrl(url: string): string {
  const urlLike = parseUrl(url);
  return urlLike.href;
}

/**
 * Get element XPath
 * @param target - target element
 * @param optimised - when id attribute of element is present the xpath can be
 * simplified to contain id
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
export function getElementXPath(target: any, optimised?: boolean): string {
  if (target.nodeType === Node.DOCUMENT_NODE) {
    return '/';
  }
  const targetValue = getNodeValue(target, optimised);
  if (optimised && targetValue.indexOf('@id') > 0) {
    return targetValue;
  }
  let xpath = '';
  if (target.parentNode) {
    xpath += getElementXPath(target.parentNode, false);
  }
  xpath += targetValue;

  return xpath;
}

/**
 * get node index within the siblings
 * @param target
 */
function getNodeIndex(target: HTMLElement): number {
  if (!target.parentNode) {
    return 0;
  }
  const allowedTypes = [target.nodeType];
  if (target.nodeType === Node.CDATA_SECTION_NODE) {
    allowedTypes.push(Node.TEXT_NODE);
  }
  let elements = Array.from(target.parentNode.childNodes);
  elements = elements.filter((element: Node) => {
    const localName = (element as HTMLElement).localName;
    return (
      allowedTypes.indexOf(element.nodeType) >= 0 &&
      localName === target.localName
    );
  });
  if (elements.length >= 1) {
    return elements.indexOf(target) + 1; // xpath starts from 1
  }
  // if there are no other similar child xpath doesn't need index
  return 0;
}

/**
 * get node value for xpath
 * @param target
 * @param optimised
 */
function getNodeValue(target: HTMLElement, optimised?: boolean): string {
  const nodeType = target.nodeType;
  const index = getNodeIndex(target);
  let nodeValue = '';
  if (nodeType === Node.ELEMENT_NODE) {
    const id = target.getAttribute('id');
    if (optimised && id) {
      return `//*[@id="${id}"]`;
    }
    nodeValue = target.localName;
  } else if (
    nodeType === Node.TEXT_NODE ||
    nodeType === Node.CDATA_SECTION_NODE
  ) {
    nodeValue = 'text()';
  } else if (nodeType === Node.COMMENT_NODE) {
    nodeValue = 'comment()';
  } else {
    return '';
  }
  // if index is 1 it can be omitted in xpath
  if (nodeValue && index > 1) {
    return `/${nodeValue}[${index}]`;
  }
  return `/${nodeValue}`;
}

/**
 * Checks if trace headers should be propagated
 * @param spanUrl
 * @private
 */
export function shouldPropagateTraceHeaders(
  spanUrl: string,
  propagateTraceHeaderCorsUrls?: PropagateTraceHeaderCorsUrls
): boolean {
  let propagateTraceHeaderUrls = propagateTraceHeaderCorsUrls || [];
  if (
    typeof propagateTraceHeaderUrls === 'string' ||
    propagateTraceHeaderUrls instanceof RegExp
  ) {
    propagateTraceHeaderUrls = [propagateTraceHeaderUrls];
  }
  const parsedSpanUrl = parseUrl(spanUrl);

  if (parsedSpanUrl.origin === getOrigin()) {
    return true;
  } else {
    return propagateTraceHeaderUrls.some(propagateTraceHeaderUrl =>
      urlMatches(spanUrl, propagateTraceHeaderUrl)
    );
  }
}
