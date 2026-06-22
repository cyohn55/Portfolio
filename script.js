// Removed unused infinite scroll code since projects are static in the HTML

// Function to smoothly scroll to the top
function scrollToTop() {
    window.scrollTo({
        top: 0,
        behavior: 'smooth' // For smooth scrolling
    });
}

// Simple word-by-word typing animation
document.addEventListener('DOMContentLoaded', function() {
    // Elements
    const typingText = document.getElementById('typing-text');
    const typingContainer = document.getElementById('typing-animation-container');
    const originalText = document.getElementById('fade-in');
    
    if (!typingText) {
        console.error('Typing text element not found!');
        return;
    }
    
    // Check for reduced motion preference
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) {
        // Just display the text normally
        return;
    }
    
    // Define exact sequence of content to be displayed
    const finalContent = `Good hiring managers<br>ask

Can you<br><span class="ocr-code">CODE</span>?

<i>Great</i> hiring<br>managers ask<br class="mobile-br">
<a href="Pages/aboutcode.html" class="red-link">'Who&nbsp;<i>IS</i><br><span class="red-code">Code</span><span class="black-question">?</span>'</a>`;

    // Pre-calculate the height by temporarily showing the full content
    function preCalculateHeight() {
        // Temporarily modify the actual element to get the final rendered height
        typingText.style.visibility = 'hidden'; // Hide it briefly
        typingText.classList.add('typing-done'); // Apply final styles
        typingText.innerHTML = finalContent.replace(/\n/g, '<br>');

        const finalHeight = typingText.offsetHeight;
        
        // Set the container height
        if (finalHeight > 0) {
            typingContainer.style.minHeight = `${finalHeight}px`;
            typingText.style.minHeight = `${finalHeight}px`;
        }
        
        // Revert the changes
        typingText.style.visibility = 'visible';
        typingText.classList.remove('typing-done');
        typingText.innerHTML = ''; // Clear it for typing
    }
    
    // Run height calculation
    preCalculateHeight();
    
    // The text is already cleared in preCalculateHeight
    // typingText.textContent = '';
    
    // Break down the content into typing sequence - word by word with pre-defined line breaks
    const typingSequence = [
        // Everyone asks - with final layout from start
        { content: "<div class=\"centered-who\"><span class=\"line-everyone\">Good hiring managers<br>&nbsp;</span></div>", delay: 400, isCentered: true },
        { content: "<div class=\"centered-who\"><span class=\"line-everyone\">Good hiring managers<br>ask</span></div>", delay: 1500, isCentered: true },
        
        // How to Code? - with final layout from start
        { content: "<div class=\"centered-who\"><span class=\"line-how\">Can<br>&nbsp;</span></div>", delay: 400, isCentered: true },
        { content: "<div class=\"centered-who\"><span class=\"line-how\">Can you<br>&nbsp;</span></div>", delay: 400, isCentered: true },
        { content: "<div class=\"centered-who\"><span class=\"line-how\">Can you<br><span class=\"ocr-code\">CODE</span>?</span></div>", delay: 1500, isCentered: true },
        
        // But, no one asks - with final layout from start
        { content: "<div class=\"centered-who\"><span class=\"line-but\"><i>Great</i> hiring<br>&nbsp;</span></div>", delay: 400, isCentered: true },
        { content: "<div class=\"centered-who\"><span class=\"line-but\"><i>Great</i> hiring<br>managers&nbsp;</span></div>", delay: 400, isCentered: true },
        { content: "<div class=\"centered-who\"><span class=\"line-but\"><i>Great</i> hiring<br>managers ask</span></div>", delay: 1500, isCentered: true, clearAfter: true },
        
        // Who is Code? - with final layout from start (keep original timing)
        { content: "<div class=\"centered-who\"><a href=\"Pages/aboutcode.html\" class=\"red-link line-who\">Who<br>&nbsp;</a></div>", delay: 600, isCentered: true },
        { content: "<div class=\"centered-who\"><a href=\"Pages/aboutcode.html\" class=\"red-link line-who\">Who&nbsp;<i>is</i><br>&nbsp;</a></div>", delay: 600, isCentered: true },
        { content: "<div class=\"centered-who\"><a href=\"Pages/aboutcode.html\" class=\"red-link line-who\">Who&nbsp;<i>is</i><br><span class=\"red-code\">Code</span><span class=\"black-question\">?</span></a></div>", delay: 800, isCentered: true, isLast: true, triggerBeFirstText: true }
    ];
    
    let currentIndex = 0;
    
    function typeNext() {
        // If we've finished all typing steps, we're done
        if (currentIndex >= typingSequence.length) {
            typingText.classList.add('typing-done');
            return;
        }
        
        const currentStep = typingSequence[currentIndex];
        
        // Ensure text is visible (no transitions)
        typingText.style.opacity = '1';
        typingText.style.transition = 'none';
        
        // Handle centered content differently based on device
        if (currentStep.isCentered && window.innerWidth > 768) {
            typingText.style.textAlign = 'center';
        } else {
            typingText.style.textAlign = 'left';
        }
        
        // Set the content
        typingText.innerHTML = currentStep.content.replace(/\n/g, '<br>');
        
        // Move to next step
        currentIndex++;
        
        // Handle clearing after this step
        if (currentStep.clearAfter) {
            setTimeout(() => {
                // Clear the content
                typingText.innerHTML = '';
                // Continue to next step after a brief pause
                setTimeout(typeNext, 500);
            }, currentStep.delay);
        } else if (currentStep.isLast) {
            // If this is the last step, finish the animation
            setTimeout(() => {
                typingText.classList.add('typing-done');
                
                // Check if we should trigger the "Be the first to ask!" text (both mobile and desktop)
                if (currentStep.triggerBeFirstText) {
                    const beFirstText = document.getElementById('be-first-text');
                    if (beFirstText) {
                        // Make the element visible and trigger fade-in
                        beFirstText.style.visibility = 'visible';
                        beFirstText.style.opacity = '1';
                    }
                }
            }, currentStep.delay);
        } else {
            setTimeout(typeNext, currentStep.delay);
        }
    }
    
    // Function to start the animation
    function startAnimation() {
        setTimeout(typeNext, 400);
    }
    
    // Check if we're on desktop (not mobile)
    const isDesktop = window.innerWidth > 768;
    
    if (isDesktop) {
        // Wait for intro text to be visible before starting animation
        const introText = document.querySelector('#about > div.default-container > div.intro-text');
        
        if (introText) {
            // Create intersection observer
            const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        // Start animation when intro text is visible
                        startAnimation();
                        // Stop observing once animation starts
                        observer.unobserve(entry.target);
                    }
                });
            }, {
                threshold: 0.1, // Trigger when 10% of the element is visible
                rootMargin: '0px 0px -50px 0px' // Start slightly before element is fully visible
            });
            
            // Start observing the intro text
            observer.observe(introText);
        } else {
            // Fallback: start animation after delay if intro text not found
            startAnimation();
        }
    } else {
        // On mobile, start animation immediately (as requested)
        startAnimation();
    }
});

// Parallax effect for .parallax-3 section if it exists
document.addEventListener('DOMContentLoaded', () => {
    const parallax3 = document.querySelector('.parallax-3');
    
    // Exit early if parallax-3 doesn't exist
    if (!parallax3) return;
    
    const layers = parallax3.querySelectorAll('.parallax-layer');

    // Check for reduced motion preference
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) return;

    let ticking = false;

    const handleScroll = () => {
        if (!ticking) {
            window.requestAnimationFrame(() => {
                const scrollTop = window.scrollY;
                const parallaxOffset = parallax3.offsetTop;
                const windowHeight = window.innerHeight;

                // Check if parallax-3 is in the viewport
                if (scrollTop + windowHeight > parallaxOffset && scrollTop < parallaxOffset + parallax3.offsetHeight) {
                    layers.forEach(layer => {
                        const speed = layer.getAttribute('data-speed');
                        const yPos = (scrollTop - parallaxOffset) * speed;
                        layer.style.transform = `translateY(${yPos}px)`;
                    });
                }
                ticking = false;
            });
            ticking = true;
        }
    };

    window.addEventListener('scroll', handleScroll);
});

// Removed commented-out carousel code (unused)

// ==========================================================================
// 3D MODEL MODAL FUNCTIONALITY
// ==========================================================================

// Global variables
let autoRotateEnabled = true;
let currentModel = 'dolphin';
let currentModelIndex = 0;
let autoCycleEnabled = true;
let autoCycleTimer = null;

// Array of model keys for cycling
const modelKeys = ['dolphin', 'bee', 'bear', 'bunny', 'fox', 'frog', 'owl', 'pig', 'turtle', 'cat', 'chicken', 'yeti'];

// Model configuration
const modelConfig = {
    dolphin: {
        file: 'models/dolphin.glb',
        title: '🐬 Interactive 3D Dolphin Model',
        emoji: '🐬',
        background: '#00bfff' // Vibrant cyan/blue
    },
    bee: {
        file: 'models/Bee.glb',
        title: '🐝 Interactive 3D Bee Model',
        emoji: '🐝',
        background: '#b300ff' // Vibrant purple
    },
    bear: {
        file: 'models/Bear.glb',
        title: '🐻 Interactive 3D Bear Model',
        emoji: '🐻',
        background: '#00ffd9' // Vibrant aqua
    },
    bunny: {
        file: 'models/Bunny.glb',
        title: '🐰 Interactive 3D Bunny Model',
        emoji: '🐰',
        background: '#ff69b4', // Vibrant hot pink
        scale: '4 4 4' // 4x larger
    },
    fox: {
        file: 'models/Fox.glb',
        title: '🦊 Interactive 3D Fox Model',
        emoji: '🦊',
        background: '#006cff' // Vibrant blue
    },
    frog: {
        file: 'models/Frog.glb',
        title: '🐸 Interactive 3D Frog Model',
        emoji: '🐸',
        background: '#ff00ff' // Vibrant magenta
    },
    owl: {
        file: 'models/Owl.glb',
        title: '🦉 Interactive 3D Owl Model',
        emoji: '🦉',
        background: '#00e1ff' // Vibrant cyan
    },
    pig: {
        file: 'models/Pig.glb',
        title: '🐷 Interactive 3D Pig Model',
        emoji: '🐷',
        background: '#00ff6a' // Vibrant green
    },
    turtle: {
        file: 'models/Turtle.glb',
        title: '🐢 Interactive 3D Turtle Model',
        emoji: '🐢',
        background: '#ff7b00' // Vibrant orange
    },
    cat: {
        file: 'models/cat.glb',
        title: '🐱 Interactive 3D Cat Model',
        emoji: '🐱',
        background: '#ffe600' // Vibrant yellow
    },
    chicken: {
        file: 'models/Chicken.glb',
        title: '🐔 Interactive 3D Chicken Model',
        emoji: '🐔',
        background: '#ff1493' // Vibrant pink
    },
    yeti: {
        file: 'models/Yeti.glb',
        title: '👾 Interactive 3D Yeti Model',
        emoji: '👾',
        background: '#007fff', // Vibrant azure
        scale: '4 4 4' // 4x larger
    }
};

// Open models modal
function openModelsModal() {
    const modal = document.getElementById('modelsModal');
    const modelViewer = modal.querySelector('model-viewer');
    const instructions = document.getElementById('zoomInstructions');
    
    modal.style.display = 'block';
    document.body.style.overflow = 'hidden'; // Prevent background scrolling
    
    // Set initial background for default model (dolphin)
    if (modelViewer && modelConfig[currentModel]) {
        modelViewer.style.background = modelConfig[currentModel].background;
    }
    
    // Make sure instructions are visible when modal opens
    if (instructions) {
        instructions.style.display = 'block';
    }
    
    // Focus on model viewer for accessibility
    setTimeout(() => {
        if (modelViewer) {
            modelViewer.focus();
        }
    }, 100);
}

// Close models modal
function closeModelsModal() {
    const modal = document.getElementById('modelsModal');
    modal.style.display = 'none';
    document.body.style.overflow = 'auto'; // Restore scrolling
}

// Switch between different 3D models
function switchModel(modelType) {
    if (!modelConfig[modelType]) {
        console.error('Unknown model type:', modelType);
        return;
    }
    
    const modal = document.getElementById('modelsModal');
    const modelViewer = modal.querySelector('#mainModelViewer');
    const modelTitle = modal.querySelector('#modelTitle');
    
    // Update current model
    currentModel = modelType;
    
    // Update model source
    if (modelViewer) {
        modelViewer.src = modelConfig[modelType].file;
        modelViewer.alt = modelConfig[modelType].title;
        // Update background color to complement the model
        modelViewer.style.background = modelConfig[modelType].background;
        // Ensure faster rotation speed
        modelViewer.setAttribute('rotation-per-second', '37.5deg');

        // Apply scale if specified in config
        if (modelConfig[modelType].scale) {
            modelViewer.scale = modelConfig[modelType].scale;
        } else {
            modelViewer.scale = '1 1 1'; // Reset to default scale
        }
    }
    
    // Update modal title
    if (modelTitle) {
        modelTitle.textContent = modelConfig[modelType].title;
    }
    
    // Update button states
    const buttons = modal.querySelectorAll('.model-btn');
    buttons.forEach(btn => {
        btn.classList.remove('active');
        if (btn.getAttribute('data-model') === modelType) {
            btn.classList.add('active');
        }
    });
    
    // Reset camera position for new model
    setTimeout(() => {
        resetCamera();
    }, 100);
}

// Reset camera to default position
function resetCamera() {
    const modal = document.getElementById('modelsModal');
    const modelViewer = modal.querySelector('model-viewer');
    
    if (modelViewer) {
        modelViewer.cameraOrbit = '45deg 75deg 20m';
        modelViewer.fieldOfView = '45deg';
    }
}

// Toggle auto-rotate functionality
function toggleAutoRotate() {
    const modal = document.getElementById('modelsModal');
    const modelViewer = modal.querySelector('model-viewer');
    
    if (modelViewer) {
        autoRotateEnabled = !autoRotateEnabled;
        
        if (autoRotateEnabled) {
            modelViewer.setAttribute('auto-rotate', '');
        } else {
            modelViewer.removeAttribute('auto-rotate');
        }
        
        // Update button text
        const button = event.target;
        button.textContent = autoRotateEnabled ? 'Stop Rotation' : 'Start Rotation';
    }
}

// Toggle zoom instructions visibility
function toggleInstructions() {
    const instructions = document.getElementById('zoomInstructions');
    if (instructions) {
        if (instructions.style.display === 'none') {
            instructions.style.display = 'block';
        } else {
            instructions.style.display = 'none';
        }
    }
}

// Embedded model viewer functions
function switchEmbeddedModel(modelType) {
    if (!modelConfig[modelType]) {
        console.error('Unknown model type:', modelType);
        return;
    }
    
    const modelViewer = document.getElementById('embeddedModelViewer');
    
    // Update current model and index
    currentModel = modelType;
    currentModelIndex = modelKeys.indexOf(modelType);
    
    // Update model source and background
    if (modelViewer) {
        modelViewer.src = modelConfig[modelType].file;
        modelViewer.alt = modelConfig[modelType].title;
        modelViewer.style.background = modelConfig[modelType].background;
        modelViewer.setAttribute('rotation-per-second', '75deg');

        // Apply scale if specified in config
        if (modelConfig[modelType].scale) {
            modelViewer.scale = modelConfig[modelType].scale;
        } else {
            modelViewer.scale = '1 1 1'; // Reset to default scale
        }
    }
    
    // Reset camera position for new model
    setTimeout(() => {
        resetEmbeddedCamera();
    }, 100);
    
    // Restart auto-cycle timer if enabled
    if (autoCycleEnabled) {
        startAutoCycle();
    }
}

function resetEmbeddedCamera() {
    const modelViewer = document.getElementById('embeddedModelViewer');
    if (modelViewer) {
        modelViewer.cameraOrbit = '45deg 75deg 20m';
        modelViewer.fieldOfView = '45deg';
    }
}

function toggleEmbeddedAutoRotate() {
    const modelViewer = document.getElementById('embeddedModelViewer');
    const toggleButton = document.getElementById('rotationToggle');
    
    if (modelViewer && toggleButton) {
        const isRotating = modelViewer.hasAttribute('auto-rotate');
        
        if (isRotating) {
            // Stop rotation and auto-cycling
            modelViewer.removeAttribute('auto-rotate');
            autoCycleEnabled = false;
            stopAutoCycle();
            toggleButton.innerHTML = '&#9658;'; // Play symbol
            toggleButton.setAttribute('aria-label', 'Start rotation');
        } else {
            // Start rotation and auto-cycling
            modelViewer.setAttribute('auto-rotate', '');
            modelViewer.setAttribute('rotation-per-second', '75deg');
            autoCycleEnabled = true;
            startAutoCycle();
            toggleButton.innerHTML = '&#9208;'; // Stop symbol
            toggleButton.setAttribute('aria-label', 'Stop rotation');
        }
    }
}



// Auto-cycle functions
function startAutoCycle() {
    clearTimeout(autoCycleTimer);
    if (autoCycleEnabled) {
        // One full rotation at 75deg/second = 360deg / 75deg = 4.8 seconds
        autoCycleTimer = setTimeout(() => {
            if (autoCycleEnabled) {
                currentModelIndex = (currentModelIndex + 1) % modelKeys.length;
                const nextModelType = modelKeys[currentModelIndex];
                switchEmbeddedModel(nextModelType);
            }
        }, 4800); // 4.8 seconds for one full rotation
    }
}

function stopAutoCycle() {
    clearTimeout(autoCycleTimer);
}



// Arrow navigation functions
function nextModel() {
    currentModelIndex = (currentModelIndex + 1) % modelKeys.length;
    const nextModelType = modelKeys[currentModelIndex];
    switchEmbeddedModel(nextModelType);
}

function previousModel() {
    currentModelIndex = (currentModelIndex - 1 + modelKeys.length) % modelKeys.length;
    const prevModelType = modelKeys[currentModelIndex];
    switchEmbeddedModel(prevModelType);
}

// Close modal when clicking outside of it
document.addEventListener('DOMContentLoaded', function() {
    const modal = document.getElementById('modelsModal');
    
    if (modal) {
        modal.addEventListener('click', function(event) {
            if (event.target === modal) {
                closeModelsModal();
            }
        });
    }
    
    // Handle escape key to close modal
    document.addEventListener('keydown', function(event) {
        if (event.key === 'Escape') {
            const modal = document.getElementById('modelsModal');
            if (modal && modal.style.display === 'block') {
                closeModelsModal();
            }
        }
    });
    
    // Handle model loading events and user interaction
    const modelViewers = document.querySelectorAll('model-viewer');
    modelViewers.forEach(viewer => {
        viewer.addEventListener('load', function() {
            // Start auto-cycle for embedded viewer
            if (viewer.id === 'embeddedModelViewer') {
                startAutoCycle();
            }
        });
        
        viewer.addEventListener('error', function(event) {
            console.error('Error loading 3D model:', event);
        });
        

    });
});


// Initialize features after DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    initializeContactForm();
    initializeDarkMode();
});

/* =====================================================================
   DARK MODE FUNCTIONALITY
   ===================================================================== */

function initializeDarkMode() {
    const darkModeToggle = document.getElementById('darkModeToggle');
    
    if (!darkModeToggle) return; // Toggle doesn't exist on this page
    
    // Check for saved theme preference or default to light mode
    const savedTheme = localStorage.getItem('theme') || 'light';
    
    // Apply saved theme
    document.documentElement.setAttribute('data-theme', savedTheme);
    
    // Add click event listener
    darkModeToggle.addEventListener('click', toggleDarkMode);
}

function toggleDarkMode() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    
    // Apply new theme
    document.documentElement.setAttribute('data-theme', newTheme);
    
    // Save preference
    localStorage.setItem('theme', newTheme);
    
    // Add transition effect
    document.body.style.transition = 'background-color 0.3s ease, color 0.3s ease';
    setTimeout(() => {
        document.body.style.transition = '';
    }, 300);
}





/* =====================================================================
   CONTACT FORM FUNCTIONALITY
   ===================================================================== */

function initializeContactForm() {
    const contactForm = document.getElementById('contactForm');
    
    if (!contactForm) return; // Form doesn't exist on this page
    
    // Check for success parameter in URL
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('success') === 'true') {
        showSuccessMessage();
        // Clean up URL
        const cleanUrl = window.location.protocol + "//" + window.location.host + window.location.pathname;
        window.history.replaceState({}, document.title, cleanUrl);
    }
    
    contactForm.addEventListener('submit', handleContactFormSubmit);
}

function showSuccessMessage() {
    // Create success message element
    const successDiv = document.createElement('div');
    successDiv.className = 'success-message';
    successDiv.innerHTML = `
        <h3>✅ Message Sent Successfully!</h3>
        <p>Thank you for reaching out! I've received your message and will get back to you within 24 hours.</p>
        <p>You can also reach me directly at:</p>
        <ul>
            <li>📧 Email: <a href="mailto:cyohn55@yahoo.com">cyohn55@yahoo.com</a></li>
            <li>📱 Phone: <a href="tel:17177589087">1-717-758-9087</a></li>
        </ul>
    `;
    
    // Insert success message before the contact form
    const formSection = document.querySelector('.contact-form-section');
    formSection.insertBefore(successDiv, formSection.firstChild);
    
    // Hide the form temporarily
    const form = document.getElementById('contactForm');
    form.style.display = 'none';
    
    // Show form again after 10 seconds
    setTimeout(() => {
        successDiv.remove();
        form.style.display = 'flex';
    }, 10000);
}

function showErrorMessage() {
    // Create error message element
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-message';
    errorDiv.innerHTML = `
        <h3>⚠️ Submission Error</h3>
        <p>There was an issue sending your message. Please try again or contact me directly:</p>
        <ul>
            <li>📧 Email: <a href="mailto:cyohn55@yahoo.com">cyohn55@yahoo.com</a></li>
            <li>📱 Phone: <a href="tel:17177589087">1-717-758-9087</a></li>
        </ul>
    `;
    
    // Insert error message before the contact form
    const formSection = document.querySelector('.contact-form-section');
    formSection.insertBefore(errorDiv, formSection.firstChild);
    
    // Remove error message after 8 seconds
    setTimeout(() => {
        errorDiv.remove();
    }, 8000);
}

function handleContactFormSubmit(event) {
    event.preventDefault(); // Prevent default form submission
    
    const form = event.target;
    const submitBtn = form.querySelector('.contact-submit-btn');
    
    // Get form data for validation
    const formData = {
        name: form.name.value.trim(),
        phone: form.phone.value.trim(),
        email: form.email.value.trim() || form._replyto.value.trim(),
        request: form.message.value.trim()
    };
    
    // Validate required fields
    if (!formData.name || !formData.email || !formData.request) {
        alert('Please fill out all required fields (Name, Email, and Request).');
        return;
    }
    
    // Show loading state
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending...';
    
    // Send both to Formspree and SMS gateway
    Promise.all([
        sendToFormspree(form, formData),
        sendToSMSGateway(formData)
    ]).then(() => {
        // Show success message
        showSuccessMessage();
        form.reset();
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send';
    }).catch((error) => {
        console.error('Error sending form:', error);
        showErrorMessage();
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send';
    });
}

function sendToFormspree(form, formData) {
    const formDataObj = new FormData(form);
    
    return fetch(form.action, {
        method: 'POST',
        body: formDataObj,
        headers: {
            'Accept': 'application/json'
        }
    }).then(response => {
        if (!response.ok) {
            throw new Error('Formspree submission failed');
        }
        return response.json();
    });
}

function sendToSMSGateway(formData) {
    // Create SMS-friendly message (keep it short for SMS)
    const smsMessage = `Portfolio Contact: ${formData.name} (${formData.email}) - ${formData.request.substring(0, 120)}${formData.request.length > 120 ? '...' : ''}`;
    
    // Use FormSubmit.co - free service that can send to any email address
    const smsFormData = new FormData();
    smsFormData.append('_to', '17177589087@tmomail.net');
    smsFormData.append('_subject', 'Portfolio SMS');
    smsFormData.append('message', smsMessage);
    smsFormData.append('name', formData.name);
    smsFormData.append('email', formData.email);
    smsFormData.append('_captcha', 'false');
    smsFormData.append('_template', 'table');
    
    return fetch('https://formsubmit.co/17177589087@tmomail.net', {
        method: 'POST',
        body: smsFormData
    }).then(response => {
        if (!response.ok) {
            // FormSubmit failed, SMS may not have been sent (non-critical)
        }
        return { success: true, service: 'formsubmit' };
    }).catch((error) => {
        // Error sending to SMS gateway (non-critical, form submission still succeeds)
        return { success: false, error: error.message };
    });
}

// =============================================================================
// RTS GAME IFRAME LOADER
// =============================================================================

/**
 * Lazy-load RTS game iframe when user clicks the "Load Game" button
 * This improves initial page load performance by deferring the game assets
 */
document.addEventListener('DOMContentLoaded', function() {
    const loadGameBtn = document.getElementById('load-game-btn');
    const rtsIframe = document.getElementById('rts-iframe');
    const gameContainer = document.querySelector('.game-container');

    // -------------------------------------------------------------------------
    // RTS scroll-lock helpers (shared by the Load Game click handler and the
    // screen-change bridge below)
    // -------------------------------------------------------------------------
    // While the game is loaded we lock mouse-wheel scrolling so the player
    // can't accidentally spin off the 100vh game canvas. The browser's
    // scrollbar still works for manual navigation because dragging the
    // scrollbar doesn't fire `wheel` events — only the wheel does — so this is
    // a targeted lock, not a full `overflow: hidden`.
    let wheelLockEngaged = false;

    // Marked non-passive so preventDefault() actually blocks the scroll.
    // Without { passive: false }, modern browsers ignore preventDefault on
    // wheel events for performance and the page would still scroll.
    const blockWheel = (event) => {
        event.preventDefault();
    };

    // Stop the iframe from chaining its scroll up to the portfolio page.
    //
    // The parent `window` wheel listener only sees wheel events that happen
    // over the parent's own DOM. Once the game fills the viewport the cursor
    // is over the iframe, so wheel events fire inside the iframe's document
    // and the parent listener never runs — the iframe then "overscroll
    // chains" the gesture up to this page and it scrolls anyway.
    //
    // `overscroll-behavior: none` on the iframe's scroll root contains that
    // chaining without swallowing the wheel itself, so the RTS still gets its
    // wheel events for camera zoom. RTS/dist is same-origin, so we can reach
    // into its document; the try/catch keeps us safe if that ever changes.
    const containIframeOverscroll = () => {
        try {
            const doc = rtsIframe.contentDocument;
            if (!doc || !doc.documentElement) return;
            doc.documentElement.style.overscrollBehavior = 'none';
            if (doc.body) doc.body.style.overscrollBehavior = 'none';
        } catch (_) {
            // Cross-origin (shouldn't happen in production) — nothing to do.
        }
    };

    // Give the RTS iframe document input focus. The Gamepad API only surfaces
    // controllers to the *focused* document, so a controller-only player gets no
    // input until the iframe (not the parent page) holds focus. We focus both the
    // element and its contentWindow; preventScroll keeps the browser from yanking
    // the page when focus lands. Wrapped in try/catch: cross-origin access would
    // throw, but RTS/dist is same-origin in production so this normally succeeds.
    const focusGameFrame = () => {
        try {
            if (rtsIframe.style.display === 'none') return; // not loaded/visible yet
            rtsIframe.focus({ preventScroll: true });
            if (rtsIframe.contentWindow) {
                rtsIframe.contentWindow.focus();
            }
        } catch (_) {
            // Cross-origin (shouldn't happen in production) — nothing to do.
        }
    };

    // -------------------------------------------------------------------------
    // Controller bridge: forward the host page's gamepad state into the iframe
    // -------------------------------------------------------------------------
    // The embedded RTS lives in a same-origin iframe. Chrome only reports a
    // gamepad to a document once that document has the page focused AND has
    // received a gamepad button-press as its own user gesture. A controller-only
    // player can't give the *iframe* that activating gesture — gamepad input is
    // not a focus gesture, so they can't move focus from this host page into the
    // iframe with the controller alone. This top page is the document the player
    // actually pressed buttons in, so it is the only one Chrome exposes the pad
    // to; the iframe's own navigator.getGamepads() stays empty and the controller
    // looks dead in-game.
    //
    // Fix: poll the pad here (we *can* read it) and forward a tiny serialized
    // snapshot into the iframe each animation frame. The game reads it as a
    // fallback (see RTS src/components/Working/gamepadSource.ts). The contract is
    // just the message shape; neither side reaches into the other's DOM.
    let gamepadForwardRafId = null;
    let gamepadPostCount = 0;

    // Opt-in live diagnostic. Append `?gpdebug` (or `#gpdebug`) to the portfolio
    // URL to show a small overlay reporting exactly where the controller chain
    // breaks: which document has focus, which document's navigator actually sees a
    // connected pad, and how many snapshots we've forwarded into the iframe.
    const gamepadDebugEnabled =
        /(^|[?#&])gpdebug(=|&|$)/.test(window.location.search + window.location.hash);
    let gamepadDebugEl = null;
    const ensureGamepadDebugOverlay = () => {
        if (!gamepadDebugEnabled || gamepadDebugEl) return;
        gamepadDebugEl = document.createElement('div');
        gamepadDebugEl.style.cssText = [
            'position:fixed', 'top:8px', 'left:8px', 'z-index:2147483647',
            'background:rgba(0,0,0,0.82)', 'color:#39ff14', 'font:12px/1.45 monospace',
            'padding:8px 10px', 'border:1px solid #39ff14', 'border-radius:6px',
            'white-space:pre', 'pointer-events:none', 'max-width:90vw',
        ].join(';');
        document.body.appendChild(gamepadDebugEl);
    };

    // Count connected pads in a given navigator, returning a short label. Wrapped
    // because reading a cross-context navigator can throw if access is ever gated.
    const describePads = (nav) => {
        try {
            if (!nav || !nav.getGamepads) return 'no API';
            const pads = Array.from(nav.getGamepads()).filter((p) => p && p.connected);
            if (pads.length === 0) return '0 connected';
            return pads.length + ' connected — ' + pads[0].id;
        } catch (e) {
            return 'read error: ' + (e && e.name);
        }
    };

    // Flatten a live Gamepad into a structured-clone-safe snapshot (postMessage
    // can't carry the native Gamepad object). Only the fields the game reads.
    const serializeGamepad = (pad) => ({
        index: pad.index,
        connected: pad.connected,
        axes: Array.from(pad.axes),
        buttons: Array.from(pad.buttons, (button) => ({
            pressed: button.pressed,
            value: button.value,
        })),
    });

    // Read the connected pads from a navigator, or [] on any failure. Same-origin
    // lets the host read BOTH its own navigator and the iframe's contentWindow
    // navigator — whichever document Chrome actually exposed the pad to.
    const readConnectedPads = (nav) => {
        try {
            if (!nav || !nav.getGamepads) return [];
            return Array.from(nav.getGamepads());
        } catch (_) {
            return [];
        }
    };
    const hasConnected = (pads) => pads.some((p) => p && p.connected);

    const forwardGamepadState = () => {
        gamepadForwardRafId = requestAnimationFrame(forwardGamepadState);

        if (!rtsIframe || rtsIframe.style.display === 'none' || !rtsIframe.contentWindow) {
            return;
        }

        // Try this (top) document's navigator first, then the iframe's own — Chrome
        // exposes the pad only to the focused, gamepad-activated document, and which
        // one that is depends on where focus landed. Reading both makes the relay
        // work regardless of focus.
        const iframeNav = rtsIframe.contentWindow.navigator;
        let pads = readConnectedPads(navigator);
        if (!hasConnected(pads)) pads = readConnectedPads(iframeNav);

        if (gamepadDebugEnabled) {
            ensureGamepadDebugOverlay();
            if (gamepadDebugEl) {
                let activeTag = '(none)';
                try {
                    const ae = document.activeElement;
                    activeTag = ae ? (ae.tagName + (ae.id ? '#' + ae.id : '')) : '(none)';
                } catch (_) { /* ignore */ }
                gamepadDebugEl.textContent =
                    'GAMEPAD BRIDGE [gpdebug]\n' +
                    'top focus:   ' + document.hasFocus() + '  active=' + activeTag + '\n' +
                    'top pads:    ' + describePads(navigator) + '\n' +
                    'iframe pads: ' + describePads(iframeNav) + '\n' +
                    'forwarded:   ' + gamepadPostCount + ' snapshots';
            }
        }

        // Build the snapshot, preserving slot indices (null for empty slots). Skip
        // the postMessage entirely when no pad is connected so we don't spam the
        // iframe — and so its own native reading wins whenever it has a real pad.
        let anyConnected = false;
        const snapshot = [];
        for (const pad of pads) {
            if (pad && pad.connected) {
                snapshot.push(serializeGamepad(pad));
                anyConnected = true;
            } else {
                snapshot.push(null);
            }
        }
        if (!anyConnected) return;

        rtsIframe.contentWindow.postMessage({ type: 'rts:gamepad', pads: snapshot }, '*');
        gamepadPostCount++;
    };

    // Start the forward loop once (idempotent). Safe to call before the iframe has
    // finished loading: the loop guards on visibility + contentWindow each frame.
    const startGamepadForwarding = () => {
        if (gamepadForwardRafId !== null) return;
        gamepadForwardRafId = requestAnimationFrame(forwardGamepadState);
    };

    const engageScrollLock = () => {
        // Align the 100vh game container's top with the viewport top so the
        // game fills the screen and nothing is cut off at the bottom. We
        // re-assert this on first load and on every screen transition to
        // override the browser's tendency to auto-scroll a freshly focused
        // iframe to the bottom of the page.
        if (gameContainer) {
            gameContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        // Contain the iframe's overscroll every time we engage — the iframe's
        // document may have (re)loaded between calls.
        containIframeOverscroll();

        if (wheelLockEngaged) return;
        window.addEventListener('wheel', blockWheel, { passive: false });
        wheelLockEngaged = true;
    };

    if (loadGameBtn && rtsIframe) {
        loadGameBtn.addEventListener('click', function() {
            // Change button text to show loading
            loadGameBtn.textContent = '⏳ Loading Game...';
            loadGameBtn.disabled = true;

            // STEP 1: Stop auto-cycling to prevent new model loads
            autoCycleEnabled = false;
            stopAutoCycle();

            // STEP 2: Close modal immediately to free its WebGL context
            const modal = document.getElementById('modelsModal');
            if (modal) {
                modal.style.display = 'none';
            }

            // STEP 3: Aggressively dispose of all model-viewer WebGL contexts
            const modelViewers = document.querySelectorAll('model-viewer');

            let disposedCount = 0;
            modelViewers.forEach((viewer, index) => {
                try {
                    // Stop rendering
                    if (viewer.pause) viewer.pause();

                    // Remove from DOM to force WebGL context release
                    viewer.style.display = 'none';
                    viewer.style.visibility = 'hidden';

                    // Clear the src to unload the model
                    viewer.src = '';

                    // Force garbage collection hint by removing rendering
                    if (viewer.shadowRoot) {
                        const canvas = viewer.shadowRoot.querySelector('canvas');
                        if (canvas) {
                            // Get WebGL context and force lose it
                            const gl = canvas.getContext('webgl') || canvas.getContext('webgl2');
                            if (gl && gl.getExtension('WEBGL_lose_context')) {
                                gl.getExtension('WEBGL_lose_context').loseContext();
                                disposedCount++;
                            }
                        }
                    }
                } catch (e) {
                    console.warn(`Failed to dispose model-viewer #${index + 1}:`, e);
                }
            });

            // STEP 4: Wait for WebGL contexts to be fully released (give browser time to clean up)
            setTimeout(() => {
                // Set iframe source to load the game
                rtsIframe.src = 'RTS/dist/index.html';

                // Show iframe immediately
                rtsIframe.style.display = 'block';

                // Begin forwarding controller state into the iframe now that it's
                // visible — a controller-only player only ever has this host page's
                // pad reading, so the game depends on this relay (see above).
                startGamepadForwarding();

                // Show only the game and lock wheel-scrolling the moment the
                // iframe is visible — don't wait for the game to report its
                // screen. This is what makes the very first Load Game press
                // snap the canvas fully into view instead of leaving it
                // half-cut at the bottom of the page.
                engageScrollLock();

                // Wait a moment then hide button
                setTimeout(() => {
                    loadGameBtn.style.display = 'none';
                }, 1000);

                // Re-assert the scroll position once the game grabs keyboard
                // focus on load — that focus otherwise makes the browser
                // auto-scroll the iframe to the bottom of the page.
                rtsIframe.addEventListener('load', function() {
                    engageScrollLock();
                    // Hand the iframe focus so the embedded game receives keyboard
                    // AND gamepad input. The Gamepad API only reports pads to the
                    // focused document, so without this the controller is invisible
                    // to the RTS while it runs inside the iframe (pads would route
                    // to this parent page instead). focus({preventScroll}) avoids
                    // re-triggering the auto-scroll engageScrollLock just corrected.
                    focusGameFrame();
                });

                // Add error event listener
                rtsIframe.addEventListener('error', function() {
                    console.error('❌ RTS game iframe failed to load');
                    loadGameBtn.textContent = '❌ Failed to Load - Try Refresh';
                    loadGameBtn.style.display = 'block';
                    loadGameBtn.disabled = false;
                    rtsIframe.style.display = 'none';
                });
            }, 500); // 500ms delay to ensure cleanup completes
        });
    }

    // -------------------------------------------------------------------------
    // RTS scroll-lock bridge
    // -------------------------------------------------------------------------
    // The embedded RTS iframe broadcasts `{ type: 'rts:screen', screen }` via
    // postMessage whenever its current screen changes (see RTS
    // src/components/Working/parentScrollBridge.ts). Once the game is loaded we
    // keep it fully in view and the mouse-wheel locked on EVERY screen —
    // including the title menu — so the player never accidentally scrolls off
    // the 100vh canvas by spinning the wheel. Re-asserting on each screen
    // transition also keeps the game in view if the player manually scrolls
    // the page and then navigates (e.g. menu → lobby). Manual escape is always
    // available via the browser's scrollbar, which doesn't fire wheel events.
    //
    // The host page never reaches into the iframe's DOM; the iframe never
    // reaches into the host's. The whole bridge is the message shape.
    if (rtsIframe && gameContainer) {
        window.addEventListener('message', (event) => {
            // Only honor messages from our embedded RTS iframe. Other widgets
            // (or browser extensions) shouldn't be able to drive the page's
            // scroll lock by spoofing the message shape.
            if (event.source !== rtsIframe.contentWindow) return;

            const data = event.data;
            if (!data || data.type !== 'rts:screen') return;

            engageScrollLock();
            // Re-assert iframe focus on every screen transition (menu → lobby →
            // playing …) so the controller keeps reporting to the game even if the
            // parent page stole focus in between (e.g. the player clicked the page).
            focusGameFrame();
        });
    }
});


