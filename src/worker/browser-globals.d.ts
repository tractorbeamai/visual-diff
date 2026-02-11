/**
 * Minimal DOM type declarations for page.evaluate() callbacks in the CDP proxy.
 * These functions are serialized by Puppeteer and executed in the browser, not
 * in the Worker runtime. Workers don't include DOM types, so we declare the
 * subset we actually use.
 */

/* eslint-disable no-var */
declare var document: {
  documentElement: Element;
  querySelector(selector: string): Element | null;
  querySelectorAll(selector: string): NodeListOf<Element>;
  title: string;
};

declare var window: {
  scrollX: number;
  scrollY: number;
  stop(): void;
  history: {
    length: number;
    go(delta: number): void;
  };
  location: {
    href: string;
  };
  getComputedStyle(element: Element): CSSStyleDeclaration;
};

declare class Node {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  children: HTMLCollection;
}

declare class Element extends Node {
  attributes: NamedNodeMap;
  children: HTMLCollection;
  outerHTML: string;
  textContent: string | null;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  getBoundingClientRect(): DOMRect;
  scrollIntoView(options?: ScrollIntoViewOptions): void;
  remove(): void;
}

interface HTMLCollection {
  length: number;
  [index: number]: Element;
  [Symbol.iterator](): Iterator<Element>;
}

interface NamedNodeMap {
  length: number;
  [index: number]: Attr;
  [Symbol.iterator](): Iterator<Attr>;
}

interface Attr {
  name: string;
  value: string;
}

interface NodeListOf<T> {
  length: number;
  [index: number]: T;
  [Symbol.iterator](): Iterator<T>;
}

interface DOMRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface CSSStyleDeclaration {
  paddingTop: string;
  paddingRight: string;
  paddingBottom: string;
  paddingLeft: string;
  borderTopWidth: string;
  borderRightWidth: string;
  borderBottomWidth: string;
  borderLeftWidth: string;
  marginTop: string;
  marginRight: string;
  marginBottom: string;
  marginLeft: string;
}

interface ScrollIntoViewOptions {
  block?: "start" | "center" | "end" | "nearest";
  inline?: "start" | "center" | "end" | "nearest";
}
