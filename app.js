(function () {
  const canvas = document.getElementById('mapCanvas');
  const ctx = canvas.getContext('2d');

  function resizeCanvas() {
    const { clientWidth, clientHeight } = canvas;
    canvas.width = clientWidth;
    canvas.height = clientHeight;
  }

  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    requestAnimationFrame(render);
  }

  window.addEventListener('resize', resizeCanvas, { passive: true });
  window.addEventListener('load', () => {
    resizeCanvas();
    render();
    console.log('app loaded');
  });
})();
