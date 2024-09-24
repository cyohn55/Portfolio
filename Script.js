document.getElementById('contact-form').addEventListener('submit', function(e) {
    e.preventDefault(); // Prevent the default form submission

    // Simple form validation
    const name = document.getElementById('name').value.trim();
    const email = document.getElementById('email').value.trim();
    const message = document.getElementById('message').value.trim();

    if (name === '' || email === '' || message === '') {
        document.getElementById('form-status').innerText = 'Please fill in all fields.';
        document.getElementById('form-status').style.color = 'red';
        return;
    }

    // Simulate form submission (since we don't have a backend)
    document.getElementById('form-status').innerText = 'Message sent successfully!';
    document.getElementById('form-status').style.color = 'green';

    // Reset the form
    document.getElementById('contact-form').reset();
});
