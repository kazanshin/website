(function () {
  document.addEventListener("DOMContentLoaded", function () {
    const dot = document.createElement("div");
    dot.style.width = "8px";
    dot.style.height = "8px";
    dot.style.borderRadius = "50%";
    dot.style.backgroundColor = "#90f090";
    dot.style.position = "fixed";
    dot.style.bottom = "12px";
    dot.style.right = "12px";
    dot.style.boxShadow = "0 0 6px #90f090";
    dot.style.opacity = "0.7";
    dot.style.zIndex = "9999";
    dot.style.animation = "pulse-seed 2.5s infinite";

    const style = document.createElement("style");
    style.textContent = `
      @keyframes pulse-seed {
        0% { transform: scale(1); opacity: 0.7; }
        50% { transform: scale(1.6); opacity: 1; }
        100% { transform: scale(1); opacity: 0.7; }
      }
    `;

    document.head.appendChild(style);
    document.body.appendChild(dot);
  });
})();
