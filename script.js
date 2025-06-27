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
    
    // Break down the content into fade sequence
    const fadeSequence = [
        {
            content: "<span class=\"line-everyone\">Everyone asks...</span>",
            fadeInDuration: 1000,
            displayDuration: 2000,
            fadeOutDuration: 1000
        },
        {
            content: "<span class=\"line-how\">'How to Code?'</span>",
            fadeInDuration: 1000,
            displayDuration: 2000,
            fadeOutDuration: 1000
        },
        {
            content: "<span class=\"line-but\">But, no one asks...</span>",
            fadeInDuration: 1000,
            displayDuration: 2000,
            fadeOutDuration: 1000
        },
        {
            content: "<a href=\"Pages/aboutcode.html\" class=\"red-link line-who\">'Who <i>IS</i> <span class=\"red-text\">Code</span>?'</a>",
            fadeInDuration: 1000,
            displayDuration: 3000, // Display longer for final text
            fadeOutDuration: 0, // Don't fade out the final text
            isLast: true
        }
    ];
    
    let currentIndex = 0;
    
    function fadeNextText() {
        // If we've finished all pieces, we're done
        if (currentIndex >= fadeSequence.length) {
            typingText.classList.add('typing-done');
            
            // Trigger the fade-in for "Be the first to ask!" after animation is done
            const fadeInElement = document.getElementById('be-first-to-ask');
            if (fadeInElement) {
                fadeInElement.classList.add('show');
            }
            return;
        }
        
        const fadeItem = fadeSequence[currentIndex];
        
        // Set the content and start invisible
        typingText.innerHTML = fadeItem.content;
        typingText.style.opacity = '0';
        typingText.style.transition = `opacity ${fadeItem.fadeInDuration}ms ease-in-out`;
        
        // Fade in
        setTimeout(() => {
            typingText.style.opacity = '1';
        }, 50); // Small delay to ensure transition is applied
        
        // After fade in completes, wait for display duration
        setTimeout(() => {
            if (fadeItem.isLast) {
                // For the last item, don't fade out and finish the animation
                typingText.classList.add('typing-done');
                
                // Trigger the fade-in for "Be the first to ask!"
                const fadeInElement = document.getElementById('be-first-to-ask');
                if (fadeInElement) {
                    fadeInElement.classList.add('show');
                }
            } else {
                // Fade out
                typingText.style.transition = `opacity ${fadeItem.fadeOutDuration}ms ease-in-out`;
                typingText.style.opacity = '0';
                
                // After fade out completes, move to next item
                setTimeout(() => {
                    currentIndex++;
                    fadeNextText();
                }, fadeItem.fadeOutDuration);
            }
        }, fadeItem.fadeInDuration + fadeItem.displayDuration);
    }
    
    // Start fade animation after a delay
    setTimeout(fadeNextText, 400);
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

