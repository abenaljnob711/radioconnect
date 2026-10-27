const pttMainBtn = document.getElementById('pttMain');

pttMainBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (isPttActive) return;
  isPttActive = true;
  if (pttMainBtn.setPointerCapture) {
    try { pttMainBtn.setPointerCapture(e.pointerId); } catch(ex){}
  }
  onPTTStart();
});

pttMainBtn.addEventListener('pointerup', (e) => {
  e.preventDefault();
  if (!isPttActive) return;
  isPttActive = false;
  if (pttMainBtn.releasePointerCapture && e.pointerId) {
    try { pttMainBtn.releasePointerCapture(e.pointerId); } catch(ex){}
  }
  stopTalking();
});

pttMainBtn.addEventListener('pointercancel', (e) => {
  e.preventDefault();
  if (!isPttActive) return;
  isPttActive = false;
  stopTalking();
});

document.body.addEventListener('touchmove', function(e) {
    if (isPttActive) e.preventDefault(); 
}, { passive: false });

pttMainBtn.addEventListener('contextmenu', (e) => e.preventDefault());
