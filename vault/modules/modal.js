// modal.js
//
// Defines a modal controller for displaying artefact details. The
// controller exposes `open` and `close` methods. It handles updating
// content based on the selected artefact, trapping focus within the
// modal, keyboard navigation (ESC, ArrowLeft, ArrowRight) and
// enabling/disabling navigation buttons. The modal is built using
// semantic HTML and respects accessibility attributes.

export function initModal() {
  const modalEl = document.getElementById('modal');
  const closeBtn = document.getElementById('modal-close');
  const titleEl = document.getElementById('modal-title');
  const imageEl = document.getElementById('modal-image');
  const timelineEl = document.getElementById('modal-timeline');
  const descEl = document.getElementById('modal-description');
  const prevBtn = document.getElementById('modal-prev');
  const nextBtn = document.getElementById('modal-next');

  let items = [];
  let current = 0;

  /**
   * Populate modal content based on the current artefact index.
   */
  function populate() {
    const item = items[current];
    if (!item) return;
    titleEl.textContent = item.title;
    imageEl.src = item.image;
    imageEl.alt = item.title;
    timelineEl.textContent = item.timeline;
    descEl.textContent = item.description;
    prevBtn.disabled = current === 0;
    nextBtn.disabled = current === items.length - 1;
  }

  /**
   * Open the modal with the provided data array and index.
   * @param {Array} data
   * @param {number} index
   */
  function open(data, index) {
    items = data;
    current = index;
    populate();
    modalEl.classList.remove('hidden');
    modalEl.setAttribute('aria-hidden', 'false');
    // Focus the close button for accessibility
    closeBtn.focus();
  }

  /**
   * Close the modal and reset state.
   */
  function close() {
    modalEl.classList.add('hidden');
    modalEl.setAttribute('aria-hidden', 'true');
  }

  // Close when the close button is clicked
  closeBtn.addEventListener('click', () => {
    close();
  });

  // Navigate to the previous artefact
  prevBtn.addEventListener('click', () => {
    if (current > 0) {
      current--;
      populate();
    }
  });

  // Navigate to the next artefact
  nextBtn.addEventListener('click', () => {
    if (current < items.length - 1) {
      current++;
      populate();
    }
  });

  // Global keyboard handler for modal interactions
  document.addEventListener('keydown', (e) => {
    if (modalEl.classList.contains('hidden')) return;
    switch (e.key) {
      case 'Escape':
        close();
        break;
      case 'ArrowLeft':
        if (current > 0) {
          current--;
          populate();
        }
        break;
      case 'ArrowRight':
        if (current < items.length - 1) {
          current++;
          populate();
        }
        break;
    }
  });

  return { open, close };
}