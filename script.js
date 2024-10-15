const projectsPerLoad = 12; // Number of projects to load each time
let currentProjectIndex = 0; // Tracks the next project to load
let isLoading = false; // Prevents multiple simultaneous loads

function loadProjects() {
    if (isLoading) return;
    isLoading = true;

    // Show loader
    document.getElementById('loader').style.display = 'block';

    // Simulate loading delay (optional)
    setTimeout(() => {
        const projectContainer = document.getElementById('project-container');
        const end = currentProjectIndex + projectsPerLoad;
        const slicedProjects = projects.slice(currentProjectIndex, end);

        slicedProjects.forEach(project => {
            const projectElement = document.createElement('div');
            projectElement.classList.add('project');

            projectElement.innerHTML = `
                <img src="${project.image}" alt="${project.title}">
                <h3>${project.title}</h3>
                <p>${project.description}</p>
                <a href="${project.link}" target="_blank">View Project</a>
            `;

            projectContainer.appendChild(projectElement);
        });

        currentProjectIndex = end;
        isLoading = false;

        // Hide loader
        document.getElementById('loader').style.display = 'none';

        // If all projects are loaded, remove the scroll event listener
        if (currentProjectIndex >= projects.length) {
            window.removeEventListener('scroll', handleScroll);
            const endMessage = document.createElement('p');
            endMessage.textContent = 'You have reached the end of the page.';
            endMessage.style.textAlign = 'center';
            endMessage.style.marginTop = '20px';
            projectContainer.appendChild(endMessage);
        }
    });
}

// Handle scroll event
function handleScroll() {
    const { scrollTop, scrollHeight, clientHeight } = document.documentElement;

    // When the user has scrolled to within 100px of the bottom, load more projects
    if (scrollTop + clientHeight >= scrollHeight - 100) {
        loadProjects();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    loadProjects(); // Initial load
    window.addEventListener('scroll', handleScroll);
});

// Function to smoothly scroll to the top
function scrollToTop() {
    window.scrollTo({
        top: 0,
        behavior: 'smooth' // For smooth scrolling
    });
}

/*var images = [
    'images/Screenshot 2024-09-22 173558.png',
    'image2.jpg',
    'image3.jpg',
];

var currentIndex = 0;
var carouselImage = document.getElementById('carousel-image');

function changeImage() {
    currentIndex++;
    if (currentIndex >= images.length) {
        currentIndex = 0;
    }
    carouselImage.src = images[currentIndex];
}

// Change image every 5000 milliseconds (5 seconds)
setInterval(changeImage, 5000); */

// script.js

document.addEventListener('DOMContentLoaded', () => {
    const parallax3 = document.querySelector('.parallax-3');
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

