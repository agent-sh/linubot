const form = document.querySelector('form'), status = document.querySelector('#status');
const code = location.hash.slice(1); history.replaceState(null, '', location.pathname);
if (/^[A-F0-9]{10}$/.test(code)) form.elements.code.value = code;
form.onsubmit = async event => {
  event.preventDefault(); const button = form.querySelector('button'); button.disabled = true; status.textContent = 'Connecting…';
  try {
    const response = await fetch('/phone-session', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({name:form.elements.name.value,code:form.elements.code.value}) });
    const result = await response.json(); if (!response.ok) throw Error(result.error || 'Pairing failed');
    location.replace('/');
  } catch(error) { status.textContent = error.message; } finally { button.disabled = false; }
};
