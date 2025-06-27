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
    
    // Break down the content into typing sequence
    const typingSequence = [
        { content: "<span class=\"line-everyone\">Everyone</span>", delay: 600 },
        { content: "<span class=\"line-everyone\">Everyone asks...</span>", delay: 800 },
        { content: "<span class=\"line-everyone\">Everyone asks...</span>\n\n<span class=\"line-how\">'How</span>", delay: 400 },
        { content: "<span class=\"line-everyone\">Everyone asks...</span>\n\n<span class=\"line-how\">'How to</span>", delay: 400 },
        { content: "<span class=\"line-everyone\">Everyone asks...</span>\n\n<span class=\"line-how\">'How to Code?'</span>", delay: 600 },
        { content: "<span class=\"line-everyone\">Everyone asks...</span>\n\n<span class=\"line-how\">'How to Code?'</span>\n\n<span class=\"line-but\">But,</span>", delay: 400 },
        { content: "<span class=\"line-everyone\">Everyone asks...</span>\n\n<span class=\"line-how\">'How to Code?'</span>\n\n<span class=\"line-but\">But, no</span>", delay: 400 },
        { content: "<span class=\"line-everyone\">Everyone asks...</span>\n\n<span class=\"line-how\">'How to Code?'</span>\n\n<span class=\"line-but\">But, no one</span>", delay: 400 },
        { content: "<span class=\"line-everyone\">Everyone asks...</span>\n\n<span class=\"line-how\">'How to Code?'</span>\n\n<span class=\"line-but\">But, no one asks...</span>", delay: 1500, clearAfter: true },
        { content: "<div class=\"centered-who\"><a href=\"Pages/aboutcode.html\" class=\"red-link line-who\">Who</a></div>", delay: 600, isCentered: true },
        { content: "<div class=\"centered-who\"><a href=\"Pages/aboutcode.html\" class=\"red-link line-who\">Who<br><i>IS</i></a></div>", delay: 600, isCentered: true },
        { content: "<div class=\"centered-who\"><a href=\"Pages/aboutcode.html\" class=\"red-link line-who\">Who<br><i>IS</i><br><span class=\"red-text\">Code</span>?</a></div>", delay: 800, isCentered: true, isLast: true }
    ];
    
    let currentIndex = 0;
    
    function typeNext() {
        // If we've finished all typing steps, we're done
        if (currentIndex >= typingSequence.length) {
            typingText.classList.add('typing-done');
            
            // Trigger the fade-in for "Be the first to ask!" after animation is done
            const fadeInElement = document.getElementById('be-first-to-ask');
            if (fadeInElement) {
                fadeInElement.classList.add('show');
            }
            return;
        }
        
        const currentStep = typingSequence[currentIndex];
        
        // Ensure text is visible (no transitions)
        typingText.style.opacity = '1';
        typingText.style.transition = 'none';
        
        // Handle centered content differently
        if (currentStep.isCentered) {
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
                
                // Trigger the fade-in for "Be the first to ask!"
                const fadeInElement = document.getElementById('be-first-to-ask');
                if (fadeInElement) {
                    fadeInElement.classList.add('show');
                }
            }, currentStep.delay);
        } else {
            setTimeout(typeNext, currentStep.delay);
        }
    }
    
    // Start typing animation after a delay
    setTimeout(typeNext, 400);
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

