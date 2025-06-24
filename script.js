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
    
    // Clear the pre-filled text (which is a fallback)
    typingText.textContent = '';
    
    // Define the sentence parts with their own lines
    const parts = [
        ["Everyone", "asks", "'How", "to", "Code?'"],
        ["But,", "no", "one", "ever", "asks...", "'Who", "IS", "Code?'"]
    ];
    
    let currentPart = 0;
    let currentWord = 0;
    let displayPart1 = '';
    let displayPart2 = '';
    
    function typeNextWord() {
        // If we're done with all parts, stop
        if (currentPart >= parts.length) {
            typingText.classList.add('typing-done');
            return;
        }
        
        // Add the next word with space if not first word
        if (currentWord < parts[currentPart].length) {
            if (currentPart === 0) {
                // First line
                if (currentWord > 0) {
                    displayPart1 += ' ';
                }
                displayPart1 += parts[currentPart][currentWord];
                
                // Update display
                typingText.innerHTML = displayPart1;
            } else {
                // Second line
                if (currentWord > 0) {
                    displayPart2 += ' ';
                }
                displayPart2 += parts[currentPart][currentWord];
                
                // Format for special styling of 'Who IS Code?'
                let formattedPart2 = displayPart2;
                if (formattedPart2.includes("'Who")) {
                    const whoIndex = formattedPart2.indexOf("'Who");
                    if (whoIndex !== -1) {
                        formattedPart2 = formattedPart2.substring(0, whoIndex) + 
                                         '<a href="Pages/aboutcode.html" class="red-link">' + 
                                         formattedPart2.substring(whoIndex) + 
                                         '</a>';
                    }
                }
                
                // Update display with both parts
                typingText.innerHTML = displayPart1 + '<br><br>' + formattedPart2;
            }
            
            currentWord++;
            
            // Determine delay based on which word
            let delay = 300; // Default delay
            
            // Special longer delays for 'Who IS Code?' part
            if (currentPart === 1 && (currentWord >= parts[1].indexOf("'Who") + 1)) {
                delay = 1000;
            }
            
            // Schedule next word
            setTimeout(typeNextWord, delay);
        } else {
            // Move to next part
            if (currentPart === 0) {
                // After first part, add a pause before the second part
                setTimeout(() => {
                    currentPart++;
                    currentWord = 0;
                    typeNextWord();
                }, 500);
            } else {
                // We're done
                typingText.classList.add('typing-done');
            }
        }
    }
    
    // Start typing after a delay
    setTimeout(typeNextWord, 300);
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

