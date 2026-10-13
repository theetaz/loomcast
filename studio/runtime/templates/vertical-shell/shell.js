// Shell timeline: the hook settles in, then each caption pops in at its own start time. Clip
// elements are timed by HyperFrames, so only their inner wrappers are animated.
(() => {
  window.__timelines = window.__timelines || {};
  const tl = gsap.timeline({ paused: true });
  tl.fromTo(
    ".lc-hook-text",
    { y: 36, opacity: 0 },
    { y: 0, opacity: 1, duration: 0.5, ease: "power3.out" },
    0.1,
  );
  tl.fromTo(".lc-brand", { opacity: 0 }, { opacity: 1, duration: 0.4, ease: "power2.out" }, 0.4);
  for (const caption of document.querySelectorAll(".lc-caption")) {
    const start = Number.parseFloat(caption.getAttribute("data-start") ?? "0");
    const inner = caption.querySelector(".lc-caption-inner");
    if (!inner) continue;
    tl.fromTo(
      inner,
      { y: 18, scale: 0.96, opacity: 0 },
      { y: 0, scale: 1, opacity: 1, duration: 0.16, ease: "power2.out" },
      start,
    );
  }
  window.__timelines["loomcast-short"] = tl;
})();
