// gallery.js
//
// Responsible for fetching artefact metadata, rendering a responsive
// gallery grid, managing locked/unlocked states based on puzzle
// completion, and opening artefact details via the provided modal
// controller. Cards are accessible via keyboard and announce their
// interactive state visually.

export function initGallery(modal) {
  const container = document.getElementById('gallery');
  if (!container) return;

  let artefacts = [];

  /**
   * Determine if the gallery is unlocked based on persisted puzzle state.
   * @returns {boolean}
   */
  function isUnlocked() {
    return localStorage.getItem('puzzleSolved') === 'true';
  }

  /**
   * Render the gallery cards based on the loaded artefacts data.
   */
  function render() {
    container.innerHTML = '';
    artefacts.forEach((item, index) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.setAttribute('tabindex', '0');
      card.dataset.index = index.toString();

      // Image thumbnail
      const img = document.createElement('img');
      img.src = item.image;
      img.alt = item.title;
      img.loading = 'lazy';
      card.appendChild(img);

      // Title
      const title = document.createElement('h3');
      title.textContent = item.title;
      card.appendChild(title);

      // If locked, overlay a padlock to indicate state
      if (!isUnlocked()) {
        const lock = document.createElement('div');
        lock.className = 'lock-overlay';
        lock.textContent = '🔒';
        card.appendChild(lock);
      }

      // Click/keypress handlers open the modal if unlocked
      const handleSelect = () => {
        if (isUnlocked() && modal) {
          modal.open(artefacts, index);
          localStorage.setItem('openedCardIndex', index.toString());
        }
      };
      card.addEventListener('click', handleSelect);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleSelect();
        }
      });

      container.appendChild(card);
    });
  }

  /**
   * Fetch artefacts metadata from the JSON file. Once loaded, render the
   * gallery and restore the previously opened artefact if appropriate.
   */
  fetch('./data/artefacts.json')
    .then((response) => response.json())
    .then((data) => {
      artefacts = data;
      render();

      // If the puzzle is already solved and an artefact was previously
      // opened, automatically re-open it after a short delay. This
      // enhances persistence across sessions without blocking initial render.
      const savedIndex = localStorage.getItem('openedCardIndex');
      if (isUnlocked() && savedIndex !== null && !isNaN(savedIndex)) {
        setTimeout(() => {
          const idx = Number(savedIndex);
          if (artefacts[idx]) {
            modal.open(artefacts, idx);
          }
        }, 400);
      }
    })
    .catch((err) => {
      console.error('Failed to load artefact data', err);
    });

  // Listen for puzzle completion to unlock the gallery
  document.addEventListener('vault:puzzleSolved', () => {
    // Remove locks from all cards
    container.querySelectorAll('.lock-overlay').forEach((overlay) => overlay.remove());
  });
}