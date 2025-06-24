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
    
    // Define the lines of text with their words
    const lines = [
        ["Everyone", "asks..."],
        ["'How", "to", "Code?'"],
        [], // Empty line for spacing
        ["But,", "no", "one", "ever", "asks..."],
        ["'Who", "IS", "Code?'"]
    ];
    
    let currentLine = 0;
    let currentWord = 0;
    let displayText = '';
    let lineBreaks = '';
    
    function typeNextWord() {
        // If we've finished all lines, we're done
        if (currentLine >= lines.length) {
            typingText.classList.add('typing-done');
            return;
        }
        
        // If this is an empty line (for spacing), just add a line break and move to the next line
        if (lines[currentLine].length === 0) {
            lineBreaks += '<br>';
            displayText += lineBreaks;
            typingText.innerHTML = displayText;
            currentLine++;
            currentWord = 0;
            setTimeout(typeNextWord, 300);
            return;
        }
        
        // If we've finished the current line, move to the next line
        if (currentWord >= lines[currentLine].length) {
            // Add line break after completing a line
            lineBreaks += '<br>';
            
            // Move to next line
            currentLine++;
            currentWord = 0;
            
            // For empty spacing line, don't add delay
            if (currentLine < lines.length && lines[currentLine].length === 0) {
                setTimeout(typeNextWord, 0);
            }
            // Special longer delay before the 'Who IS Code?' part
            else if (currentLine === 4) {
                setTimeout(typeNextWord, 1000); // 1 second delay before "Who IS Code?"
            }
            // Standard delay between lines
            else {
                setTimeout(typeNextWord, 300);
            }
            return;
        }
        
        // Add the next word with space if not first word
        if (currentWord > 0) {
            displayText += ' ';
        }
        
        // Add the word
        displayText += lines[currentLine][currentWord];
        
        // Format with proper styling for 'Who IS Code?' part
        let formattedText = displayText;
        if (currentLine === 4) { // If we're on the 'Who IS Code?' line
            const whoText = "'Who IS Code?'";
            const whoIndex = formattedText.lastIndexOf("'Who");
            if (whoIndex !== -1) {
                formattedText = formattedText.substring(0, whoIndex) + 
                                '<a href="Pages/aboutcode.html" class="red-link">' + 
                                whoText + 
                                '</a>';
            }
        }
        
        // Add line breaks
        typingText.innerHTML = formattedText + lineBreaks;
        
        // Move to next word
        currentWord++;
        
        // Determine delay - special longer delays for 'Who IS Code?' part
        let delay = 300; // Default delay
        
        if (currentLine === 4) { // If we're on the "Who IS Code?" line
            delay = 1000; // Longer delay for each word in this line
        }
        
        // Schedule next word
        setTimeout(typeNextWord, delay);
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

