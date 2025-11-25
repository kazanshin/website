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

document.addEventListener('DOMContentLoaded', () => {
  // Initialise the modal controller first so it can be passed to the gallery
  const modal = initModal();

  // Initialise the door interaction
  initDoor();

  // Initialise the puzzle; it will decide whether to show itself based on
  // localStorage and listen for the doorOpen event
  initPuzzle();

  // Initialise the gallery; pass the modal controller so it can open
  // artefact details when a card is selected
  initGallery(modal);
});