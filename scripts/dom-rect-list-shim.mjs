// Adapter tests stub getClientRects() with a plain array. The DOM method is DOMRectList.item().
if (typeof Array.prototype.item !== "function") {
  Object.defineProperty(Array.prototype, "item", {
    configurable: true,
    writable: true,
    value(index) {
      const position = Number(index);
      if (!Number.isInteger(position) || position < 0 || position >= this.length) return null;
      return this[position];
    },
  });
}
