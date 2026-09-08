import message from './message.js';
document.getElementById('message').textContent = message;
if (import.meta.hot) import.meta.hot.accept('./message.js', module => { document.getElementById('message').textContent = module.default; });
