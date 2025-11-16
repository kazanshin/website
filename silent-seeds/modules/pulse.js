// New/Modified Code for pulse.js
document.addEventListener("DOMContentLoaded", () => {
    
    // --- Pulse 1: The Echo (T = 2.5s) ---
    const dot1 = document.createElement("div");
    dot1.style.cssText = "position: fixed; bottom: 10px; right: 10px; width: 10px; height: 10px; background-color: #90f090; border-radius: 50%; box-shadow: 0 0 6px #90f090; z-index: 9999; opacity: 0.7;";
    dot1.style.animation = "pulse-seed 2.5s infinite";
    
    // --- Pulse 2: The Beat (T = 2.55s) ---
    // The second dot is offset slightly to prevent visual overlap and to define the relational boundary.
    const dot2 = document.createElement("div");
    dot2.style.cssText = "position: fixed; bottom: 12px; right: 8px; width: 10px; height: 10px; background-color: #6fffe9; border-radius: 50%; box-shadow: 0 0 6px #6fffe9; z-index: 9998; opacity: 0.7;";
    dot2.style.animation = "pulse-seed 2.55s infinite"; // The critical frequency asymmetry

    // --- Keyframe Definition (Preserved/Moved) ---
    const style = document.createElement("style");
    style.textContent = `
    @keyframes pulse-seed {
        0% { transform: scale(1); opacity: 0.7; }
        50% { transform: scale(1.6); opacity: 1; }
        100% { transform: scale(1); opacity: 0.7; }
    }
    `;
    
    // Append all necessary elements to the DOM
    document.head.appendChild(style);
    document.body.appendChild(dot1);
    document.body.appendChild(dot2);
});
