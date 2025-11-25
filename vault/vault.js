// Main orchestrator for the Vault of Impossible Futures
//
// This module imports the individual components and initialises them on
// page load. It wires together the custom events emitted by the door
// and puzzle modules and passes a reference to the modal controller to
// the gallery module. State restoration (puzzle solved and last viewed
// artefact) is handled within the respective modules.

import { initDoor } from './modules/door.js';
import { initPuzzle } from './modules/puzzle.js';
import { initGallery } from './modules/gallery.js';
import { initModal } from './modules/modal.js';

/**
 * Initialise all modules required by the Vault page. This function is
 * called once the DOM is available. If the script executes after
 * DOMContentLoaded has already fired (which is the case when the module
 * is loaded at the end of the body), it runs immediately. Otherwise
 * initialisation is deferred until DOMContentLoaded.
 */
function init() {
  const modal = initModal();
  initDoor();
  initPuzzle();
  initGallery(modal);
}

// If the document is still loading, defer initialisation until
// DOMContentLoaded fires. Otherwise initialise immediately.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}