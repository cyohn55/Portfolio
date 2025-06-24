// Removed unused infinite scroll code since projects are static in the HTML

// Function to smoothly scroll to the top
function scrollToTop() {
    window.scrollTo({
        top: 0,
        behavior: 'smooth' // For smooth scrolling
    });
}

// Word-by-word typing animation
document.addEventListener('DOMContentLoaded', () => {
    // Check for reduced motion preference
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    
    // Typing animation
    const typingAnimation = () => {
        const originalText = document.getElementById('fade-in');
        const typingContainer = document.getElementById('typing-text');
        
        if (!originalText || !typingContainer) return;
        
        // Skip animation for reduced motion
        if (prefersReducedMotion) {
            originalText.style.visibility = 'visible';
            typingContainer.style.display = 'none';
            return;
        }
        
        // Extract the text to animate
        const line1Full = "Everyone asks 'How to Code?'";
        const line2Full = "But, no one ever asks... 'Who IS Code?'";
        
        // Split into words preserving punctuation
        const wordsToType = [];
        let currentWord = '';
        let line1Words = 0;
        
        // Process line 1
        for (let i = 0; i < line1Full.length; i++) {
            const char = line1Full[i];
            if (char === ' ') {
                if (currentWord) {
                    wordsToType.push(currentWord);
                    currentWord = '';
                    line1Words++;
                }
            } else {
                currentWord += char;
            }
        }
        if (currentWord) {
            wordsToType.push(currentWord);
            currentWord = '';
            line1Words++;
        }
        
        // Process line 2
        for (let i = 0; i < line2Full.length; i++) {
            const char = line2Full[i];
            if (char === ' ') {
                if (currentWord) {
                    wordsToType.push(currentWord);
                    currentWord = '';
                }
            } else {
                currentWord += char;
            }
        }
        if (currentWord) {
            wordsToType.push(currentWord);
        }
        
        let currentText = '';
        let currentWordIndex = 0;
        let currentLine = 1;
        
        // Initialize with empty content
        typingContainer.textContent = '';
        
        // Function to add the next word
        const addNextWord = () => {
            if (currentWordIndex < wordsToType.length) {
                // Add space before if not first word
                if (currentWordIndex > 0) {
                    currentText += ' ';
                }
                
                // Add the next word
                currentText += wordsToType[currentWordIndex];
                currentWordIndex++;
                
                // Format the text with proper styling
                let formattedText = '';
                
                // Check if we're moving to line 2
                if (currentWordIndex === line1Words && currentLine === 1) {
                    formattedText = currentText + '<br>';
                    currentLine = 2;
                } else {
                    formattedText = currentText;
                }
                
                // Style "Who IS Code?" with red link when those words start appearing
                if (currentLine === 2 && formattedText.includes("'Who")) {
                    const parts = formattedText.split("'Who");
                    formattedText = parts[0] + '<a href="Pages/aboutcode.html" class="red-link">\'Who' + 
                        (parts.length > 1 ? parts[1] : '') + '</a>';
                }
                
                typingContainer.innerHTML = formattedText;
                
                // Determine the delay for the next word
                let delay = 300; // Default delay of 300ms
                
                // Special delays for emphasis on "Who IS Code?"
                if (formattedText.includes("'Who")) {
                    delay = 1000; // Longer delay for the Who IS Code part
                }
                
                // Schedule the next word
                setTimeout(addNextWord, delay);
            }
            else {
                // Animation complete - hide the cursor
                typingContainer.classList.add('typing-done');
            }
        };
        
        // Start the typing animation after a short delay
        setTimeout(addNextWord, 300);
    };
    
    // Run the typing animation
    typingAnimation();
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

