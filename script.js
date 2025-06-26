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

But, no one ever asks...
<a href="Pages/aboutcode.html" class="red-link">'Who IS Code?'</a>`;

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
    
    // Break down the content into pieces for typing
    const typingSequence = [
        // Line 1
        { text: "Everyone ", delay: 600 },
        { text: "asks...", delay: 800 },
        
        // Line 2
        { text: "\n'How ", delay: 400 },
        { text: "to ", delay: 400 },
        { text: "Code?'", delay: 400 },
        
        // Single blank line - slightly longer delay
        { text: "\n\n", delay: 800 },
        
        // Line 4
        { text: "But, ", delay: 400 },
        { text: "no ", delay: 300 },
        { text: "one ", delay: 400 },
        { text: "ever ", delay: 400 },
        { text: "asks...", delay: 800 }, // Longer delay before the Who IS Code part
        
        // Line 5 with special styling
        { text: "\n'Who ", delay: 500, isWhoLine: true },
        { text: "IS ", delay: 400, isWhoLine: true },
        { text: "Code?'", delay: 400, isWhoLine: true, isLast: true }
    ];
    
    let currentIndex = 0;
    let currentText = '';
    let whoLineStarted = false;
    let whoLineContent = '';
    
    function typeNextPiece() {
        // If we've finished all pieces, we're done
        if (currentIndex >= typingSequence.length) {
            typingText.classList.add('typing-done');
            return;
        }
        
        const piece = typingSequence[currentIndex];
        
        // Handle the "Who IS Code?" line specially
        if (piece.isWhoLine) {
            if (!whoLineStarted) {
                whoLineStarted = true;
                whoLineContent = '';
            }
            
            whoLineContent += piece.text;
            
            // Format the entire text
            const beforeWho = currentText;
            const formatted = beforeWho + `<a href="Pages/aboutcode.html" class="red-link">${whoLineContent}</a>`;
            
            // Replace \n with <br> for HTML
            typingText.innerHTML = formatted.replace(/\n/g, '<br>');
            
            // If this is the last piece, we're done
            if (piece.isLast) {
                setTimeout(() => {
                    typingText.classList.add('typing-done');
                }, piece.delay);
            } else {
                currentIndex++;
                setTimeout(typeNextPiece, piece.delay);
            }
        } 
        else {
            // Regular text
            currentText += piece.text;
            
            // Replace \n with <br> for HTML
            typingText.innerHTML = currentText.replace(/\n/g, '<br>');
            
            currentIndex++;
            setTimeout(typeNextPiece, piece.delay);
        }
    }
    
    // Start typing after a delay
    setTimeout(typeNextPiece, 400);
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

