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
    console.log('DOM loaded');
    
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
    const finalContent = `Everyone asks...

'How to Code?'

But, no one asks...<br class="mobile-br">
<a href="Pages/aboutcode.html" class="red-link">'Who <i>IS</i> <span class="red-text">Code</span>?'</a>`;

    // Pre-calculate the height by temporarily showing the full content
    function preCalculateHeight() {
        // Temporarily modify the actual element to get the final rendered height
        typingText.style.visibility = 'hidden'; // Hide it briefly
        typingText.classList.add('typing-done'); // Apply final styles
        typingText.innerHTML = finalContent.replace(/\n/g, '<br>');

        const finalHeight = typingText.offsetHeight;
        console.log("Calculated final height:", finalHeight);
        
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
    
    // Break down the content into typing + fade sequence
    const typingFadeSequence = [
        {
            texts: [
                { content: "<span class=\"line-everyone\">Everyone</span>", delay: 600 },
                { content: "<span class=\"line-everyone\">Everyone asks...</span>", delay: 800 }
            ],
            fadeOutDuration: 1000,
            pauseAfterFade: 500
        },
        {
            texts: [
                { content: "<span class=\"line-how\">'How</span>", delay: 400 },
                { content: "<span class=\"line-how\">'How to</span>", delay: 400 },
                { content: "<span class=\"line-how\">'How to Code?'</span>", delay: 600 }
            ],
            fadeOutDuration: 1000,
            pauseAfterFade: 500
        },
        {
            texts: [
                { content: "<span class=\"line-but\">But,</span>", delay: 400 },
                { content: "<span class=\"line-but\">But, no</span>", delay: 400 },
                { content: "<span class=\"line-but\">But, no one</span>", delay: 400 },
                { content: "<span class=\"line-but\">But, no one asks...</span>", delay: 800 }
            ],
            fadeOutDuration: 1000,
            pauseAfterFade: 500
        },
        {
            texts: [
                { content: "<a href=\"Pages/aboutcode.html\" class=\"red-link line-who\">'Who</a>", delay: 500 },
                { content: "<a href=\"Pages/aboutcode.html\" class=\"red-link line-who\">'Who <i>IS</i></a>", delay: 600 },
                { content: "<a href=\"Pages/aboutcode.html\" class=\"red-link line-who\">'Who <i>IS</i> <span class=\"red-text\">Code</span>?'</a>", delay: 800 }
            ],
            fadeOutDuration: 0, // Don't fade out the final text
            pauseAfterFade: 0,
            isLast: true
        }
    ];
    
    let currentSequenceIndex = 0;
    let currentTextIndex = 0;
    
    function typeAndFadeNext() {
        // If we've finished all sequences, we're done
        if (currentSequenceIndex >= typingFadeSequence.length) {
            typingText.classList.add('typing-done');
            
            // Trigger the fade-in for "Be the first to ask!" after animation is done
            const fadeInElement = document.getElementById('be-first-to-ask');
            if (fadeInElement) {
                fadeInElement.classList.add('show');
            }
            return;
        }
        
        const sequence = typingFadeSequence[currentSequenceIndex];
        
        // If we're starting a new sequence, reset text index and make visible
        if (currentTextIndex === 0) {
            typingText.style.opacity = '1';
            typingText.style.transition = 'none'; // No transition for typing
        }
        
        // If we've finished typing all texts in this sequence
        if (currentTextIndex >= sequence.texts.length) {
            if (sequence.isLast) {
                // For the last sequence, don't fade out and finish the animation
                typingText.classList.add('typing-done');
                
                // Trigger the fade-in for "Be the first to ask!"
                const fadeInElement = document.getElementById('be-first-to-ask');
                if (fadeInElement) {
                    fadeInElement.classList.add('show');
                }
            } else {
                // Fade out the completed sequence
                typingText.style.transition = `opacity ${sequence.fadeOutDuration}ms ease-in-out`;
                typingText.style.opacity = '0';
                
                // After fade out completes, move to next sequence
                setTimeout(() => {
                    currentSequenceIndex++;
                    currentTextIndex = 0;
                    setTimeout(typeAndFadeNext, sequence.pauseAfterFade);
                }, sequence.fadeOutDuration);
            }
            return;
        }
        
        // Type the current text
        const currentText = sequence.texts[currentTextIndex];
        typingText.innerHTML = currentText.content;
        
        // Move to next text in sequence
        currentTextIndex++;
        setTimeout(typeAndFadeNext, currentText.delay);
    }
    
    // Start typing animation after a delay
    setTimeout(typeAndFadeNext, 400);
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

