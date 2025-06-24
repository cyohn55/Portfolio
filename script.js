// Removed unused infinite scroll code since projects are static in the HTML

// Function to smoothly scroll to the top
function scrollToTop() {
    window.scrollTo({
        top: 0,
        behavior: 'smooth' // For smooth scrolling
    });
}

// Typing animation for the heading
document.addEventListener('DOMContentLoaded', function() {
    const typingText = document.getElementById('typing-text');
    const container = document.getElementById('typing-animation-container');
    
    // Text to be displayed line by line
    const textLines = [
        "Everyone asks",
        "'How to Code?'",
        "But, no one ever asks...",
        "'Who IS Code?'"
    ];
    
    // Create a temporary element to measure the final height
    const tempElement = document.createElement('h1');
    tempElement.id = 'temp-typing-text';
    tempElement.style.visibility = 'hidden';
    tempElement.style.position = 'absolute';
    tempElement.style.width = typingText.offsetWidth + 'px';
    tempElement.classList.add('typing-done'); // Apply the same styling as the final state
    
    // Add the complete text to measure final height
    textLines.forEach((line, index) => {
        const lineElement = document.createElement('div');
        lineElement.textContent = line;
        tempElement.appendChild(lineElement);
    });
    
    document.body.appendChild(tempElement);
    
    // Set the container height based on the measured height
    const finalHeight = tempElement.offsetHeight;
    container.style.height = finalHeight + 'px';
    
    // Remove the temporary element
    document.body.removeChild(tempElement);
    
    // Clear any existing content
    typingText.innerHTML = '';
    
    // Create line elements
    const lineElements = textLines.map(line => {
        const lineElement = document.createElement('div');
        lineElement.style.opacity = '0';
        lineElement.textContent = line;
        typingText.appendChild(lineElement);
        return lineElement;
    });
    
    // Animation timing
    const delay = 400; // ms between words
    
    // Animate each line sequentially
    lineElements.forEach((lineElement, index) => {
        setTimeout(() => {
            lineElement.style.opacity = '1';
            
            // If this is the last line, add the typing-done class
            if (index === lineElements.length - 1) {
                setTimeout(() => {
                    typingText.classList.add('typing-done');
                    
                    // Adjust container height to match the final text height
                    container.style.height = typingText.offsetHeight + 'px';
                }, delay);
            }
        }, index * delay);
    });
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

