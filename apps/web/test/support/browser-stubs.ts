/**
 * APIs jsdom lacks that Radix and the sidebar call: `matchMedia` (a desktop
 * pointer, light scheme, wide viewport), `ResizeObserver` and pointer capture.
 */
export function installBrowserStubs() {
  window.matchMedia = (query: string) =>
    ({
      media: query,
      matches: query.includes("hover: hover") || query.includes("pointer: fine"),
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;

  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
  window.scrollTo = () => {};
}
