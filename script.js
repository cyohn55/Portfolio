// Removed unused infinite scroll code since projects are static in the HTML

// Function to smoothly scroll to the top
function scrollToTop() {
    window.scrollTo({
        top: 0,
        behavior: 'smooth' // For smooth scrolling
    });
}

// Simple word-by-word typing animation - IMPROVED VERSION
document.addEventListener('DOMContentLoaded', function() {
    console.log('DOM loaded');
    
    // Elements
    const typingContainer = document.getElementById('typing-animation-container');
    const animationStage = document.getElementById('animation-stage');
    
    if (!animationStage) {
        console.error('Animation stage element not found!');
        return;
    }
    
    // Check for reduced motion preference
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) {
        // Just display the final state
        const finalStep = document.getElementById('step-who-3');
        if (finalStep) {
            finalStep.classList.add('active');
            // Show "Be the first to ask!" text immediately on desktop
            if (window.innerWidth > 768) {
                const beFirstText = document.getElementById('be-first-text');
                if (beFirstText) {
                    beFirstText.style.display = 'block';
                    beFirstText.style.opacity = '1';
                }
            }
        }
        return;
    }
    
    // Animation sequence with step IDs and timing
    const animationSequence = [
        // Everyone asks sequence
        { stepId: 'step-everyone-1', delay: 400 },
        { stepId: 'step-everyone-2', delay: 1500 },
        
        // Can you CODE? sequence
        { stepId: 'step-code-1', delay: 400, clearPrevious: true },
        { stepId: 'step-code-2', delay: 400 },
        { stepId: 'step-code-3', delay: 1500 },
        
        // But, have you asked sequence
        { stepId: 'step-but-1', delay: 400, clearPrevious: true },
        { stepId: 'step-but-2', delay: 400 },
        { stepId: 'step-but-3', delay: 400 },
        { stepId: 'step-but-4', delay: 1500 },
        
        // Who is Code? sequence
        { stepId: 'step-who-1', delay: 600, clearPrevious: true },
        { stepId: 'step-who-2', delay: 600 },
        { stepId: 'step-who-3', delay: 800, isLast: true, triggerBeFirstText: true }
    ];
    
    let currentIndex = 0;
    let activeStep = null;
    
    function showStep(stepId) {
        const step = document.getElementById(stepId);
        if (step) {
            step.classList.add('active');
            activeStep = step;
        }
    }
    
    function hideStep(stepId) {
        const step = document.getElementById(stepId);
        if (step) {
            step.classList.remove('active');
            step.classList.add('fade-out');
            // Remove fade-out class after animation
            setTimeout(() => {
                step.classList.remove('fade-out');
            }, 300);
        }
    }
    
    function clearAllSteps() {
        const allSteps = document.querySelectorAll('.animation-step');
        allSteps.forEach(step => {
            step.classList.remove('active');
        });
        activeStep = null;
    }
    
    function animateNext() {
        if (currentIndex >= animationSequence.length) {
            return;
        }
        
        const currentAnimation = animationSequence[currentIndex];
        
        // Clear previous steps if specified
        if (currentAnimation.clearPrevious) {
            clearAllSteps();
        }
        
        // Show current step
        showStep(currentAnimation.stepId);
        
        // Handle final step
        if (currentAnimation.isLast) {
            setTimeout(() => {
                // Trigger "Be the first to ask!" text on desktop only
                if (currentAnimation.triggerBeFirstText && window.innerWidth > 768) {
                    const beFirstText = document.getElementById('be-first-text');
                    if (beFirstText) {
                        beFirstText.style.display = 'block';
                        setTimeout(() => {
                            beFirstText.style.opacity = '1';
                        }, 100);
                    }
                }
            }, currentAnimation.delay);
        } else {
            // Move to next step after delay
            setTimeout(() => {
                currentIndex++;
                animateNext();
            }, currentAnimation.delay);
        }
        
        currentIndex++;
    }
    
    // Function to start the animation
    function startAnimation() {
        setTimeout(() => {
            animateNext();
        }, 400);
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
                threshold: 0.1,
                rootMargin: '0px 0px -50px 0px'
            });
            
            observer.observe(introText);
        } else {
            startAnimation();
        }
    } else {
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

