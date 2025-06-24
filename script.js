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
    
    // Define the sentences
    const sentences = [
        "Everyone asks 'How to Code?'",
        "But, no one ever asks... 'Who IS Code?'"
    ];
    
    // Create arrays of words
    const words = sentences.map(sentence => sentence.split(' '));
    
    let currentSentence = 0;
    let currentWord = 0;
    let displayText = '';
    
    function typeNextWord() {
        // If we're at the end of all sentences, stop
        if (currentSentence >= sentences.length) {
            typingText.classList.add('typing-done');
            return;
        }
        
        // Add the next word
        if (currentWord < words[currentSentence].length) {
            // Add space if not the first word
            if (currentWord > 0) {
                displayText += ' ';
            }
            
            // Add the word
            displayText += words[currentSentence][currentWord];
            currentWord++;
            
            // Format the text
            let formattedText = displayText;
            
            // Add styling for 'Who IS Code?' part
            if (currentSentence === 1 && formattedText.includes("'Who")) {
                const parts = formattedText.split("'Who");
                formattedText = parts[0] + '<a href="Pages/aboutcode.html" class="red-link">\'Who' + 
                    (parts.length > 1 ? parts[1] : '') + '</a>';
            }
            
            typingText.innerHTML = formattedText;
            
            // Determine the delay
            let delay = 300; // Default
            
            if (formattedText.includes("'Who")) {
                delay = 1000; // Longer for emphasizing "Who IS Code?"
            }
            
            // Schedule next word
            setTimeout(typeNextWord, delay);
        } else {
            // Move to next sentence
            if (currentSentence < sentences.length - 1) {
                displayText += '<br>';
                typingText.innerHTML = displayText;
                currentSentence++;
                currentWord = 0;
                setTimeout(typeNextWord, 500); // Wait before starting next line
            } else {
                // We're done
                typingText.classList.add('typing-done');
            }
        }
    }
    
    // Start typing after a delay
    setTimeout(typeNextWord, 500);
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

