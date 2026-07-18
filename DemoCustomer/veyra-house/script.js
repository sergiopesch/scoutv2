const header = document.querySelector('[data-header]');
const menuButton = document.querySelector('[data-menu-button]');
const mobileNav = document.querySelector('[data-mobile-nav]');
const bookingDialog = document.querySelector('[data-booking-dialog]');
const bookingForm = document.querySelector('[data-booking-form]');
const dialogOptions = document.querySelector('[data-dialog-options]');
const dialogSuccess = document.querySelector('[data-dialog-success]');
const practiceSelect = document.querySelector('[data-practice-select]');
const caveat = document.querySelector('[data-booking-caveat]');
const dialogTitle = document.querySelector('[data-dialog-title]');
const dialogIntro = document.querySelector('[data-dialog-intro]');

const bookingCopy = {
  visit: {
    title: 'Where would you like to begin?',
    intro: 'Choose the practice that brings you to the house. Availability and eligibility are confirmed in the next step.'
  },
  class: {
    title: 'Find a training session.',
    intro: 'Classes and coached sessions are managed in the training calendar.',
    caveat: 'Class availability is confirmed in the training calendar.'
  },
  treatment: {
    title: 'Choose time to restore.',
    intro: 'Bodywork and recovery appointments are managed by the treatment team.',
    caveat: 'Treatment availability is confirmed in a separate appointment calendar.'
  },
  ritual: {
    title: 'Request a day ritual.',
    intro: 'A host will confirm the practices available to guests on your preferred day.',
    caveat: 'Guest ritual capacity is released weekly after member priority is protected.'
  },
  membership: {
    title: 'Begin a conversation.',
    intro: 'Membership begins with a house tour, a movement conversation and a first ritual.',
    caveat: 'Membership conversations are arranged by the house team.'
  },
  arrival: {
    title: 'Plan your arrival.',
    intro: 'Tell us when you expect to visit and the host team will share arrival details.',
    caveat: 'Arrival planning does not reserve a class, treatment or guest ritual.'
  }
};

function setHeaderState() {
  header.classList.toggle('is-scrolled', window.scrollY > 48 && !document.body.classList.contains('is-menu-open'));
}

function closeMenu() {
  document.body.classList.remove('is-menu-open');
  header.classList.remove('is-menu-open');
  menuButton.setAttribute('aria-expanded', 'false');
  mobileNav.hidden = true;
  setHeaderState();
}

menuButton.addEventListener('click', () => {
  const willOpen = !document.body.classList.contains('is-menu-open');
  document.body.classList.toggle('is-menu-open', willOpen);
  header.classList.toggle('is-menu-open', willOpen);
  menuButton.setAttribute('aria-expanded', String(willOpen));
  mobileNav.hidden = !willOpen;
  if (willOpen) header.classList.remove('is-scrolled');
  else setHeaderState();
});

mobileNav.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeMenu));
window.addEventListener('scroll', setHeaderState, { passive: true });
window.addEventListener('load', setHeaderState);
setHeaderState();
requestAnimationFrame(setHeaderState);

const stateMedia = document.querySelector('[data-states-media]');
const stateCaption = document.querySelector('[data-state-caption]');
document.querySelectorAll('[data-state]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-state]').forEach((item) => {
      const active = item === button;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-selected', String(active));
    });
    stateMedia.dataset.view = button.dataset.state;
    stateCaption.textContent = button.querySelector('strong').textContent;
  });
});

const dayMedia = document.querySelector('.day-media');
document.querySelectorAll('[data-schedule]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-schedule]').forEach((item) => {
      const active = item === button;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-selected', String(active));
    });
    dayMedia.dataset.view = button.dataset.schedule;
  });
});

function resetDialog() {
  bookingForm.hidden = true;
  dialogSuccess.hidden = true;
  dialogOptions.hidden = false;
  bookingForm.reset();
  dialogTitle.textContent = bookingCopy.visit.title;
  dialogIntro.textContent = bookingCopy.visit.intro;
}

function showBookingForm(type) {
  const selectedType = bookingCopy[type] ? type : 'class';
  const copy = bookingCopy[selectedType];
  dialogTitle.textContent = copy.title;
  dialogIntro.textContent = copy.intro;
  practiceSelect.value = selectedType === 'visit' ? 'class' : selectedType;
  caveat.textContent = copy.caveat || bookingCopy.class.caveat;
  dialogOptions.hidden = true;
  dialogSuccess.hidden = true;
  bookingForm.hidden = false;
  practiceSelect.focus();
}

function openBooking(type) {
  closeMenu();
  resetDialog();
  const selectedType = type || 'visit';
  if (selectedType !== 'visit') showBookingForm(selectedType);
  bookingDialog.showModal();
}

document.querySelectorAll('[data-open-booking]').forEach((button) => {
  button.addEventListener('click', () => openBooking(button.dataset.openBooking));
});

document.querySelectorAll('[data-booking-choice]').forEach((button) => {
  button.addEventListener('click', () => showBookingForm(button.dataset.bookingChoice));
});

document.querySelector('[data-booking-back]').addEventListener('click', resetDialog);

document.querySelectorAll('[data-close-dialog]').forEach((button) => {
  button.addEventListener('click', () => bookingDialog.close());
});

bookingDialog.addEventListener('click', (event) => {
  if (event.target === bookingDialog) bookingDialog.close();
});

practiceSelect.addEventListener('change', () => {
  const copy = bookingCopy[practiceSelect.value];
  if (copy?.caveat) caveat.textContent = copy.caveat;
});

bookingForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!bookingForm.reportValidity()) return;
  bookingForm.hidden = true;
  dialogSuccess.hidden = false;
  dialogTitle.textContent = 'A quiet handoff.';
  dialogIntro.textContent = 'The selected path is ready to continue.';
});

const newsletter = document.querySelector('[data-newsletter]');
newsletter.addEventListener('submit', (event) => {
  event.preventDefault();
  const status = document.querySelector('[data-newsletter-status]');
  status.textContent = 'Thank you. This fictional form does not submit personal data.';
  newsletter.reset();
});

const revealItems = document.querySelectorAll('.reveal');
if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.14, rootMargin: '0px 0px -50px' });
  revealItems.forEach((item) => observer.observe(item));
} else {
  revealItems.forEach((item) => item.classList.add('is-visible'));
}
