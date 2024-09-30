const projectsPerLoad = 12; // Number of projects to load each time
let currentProjectIndex = 0; // Tracks the next project to load
let isLoading = false; // Prevents multiple simultaneous loads

// Array of project objects
const projects = [
    {
        title: "Project 1",
        description: "Description for Project 1.",
        image: "images/project1.jpg", // Ensure these images exist in your 'images' folder
        link: "https://github.com/username/project1"
    },
    {
        title: "Project 2",
        description: "Description for Project 2.",
        image: "images/project2.jpg",
        link: "https://github.com/username/project2"
    },
    {
        title: "Project 3",
        description: "Description for Project 3.",
        image: "images/project1.jpg", // Ensure these images exist in your 'images' folder
        link: "https://github.com/username/project1"
    },
    {
        title: "Project 4",
        description: "Description for Project 4.",
        image: "images/project2.jpg",
        link: "https://github.com/username/project2"
    },
    {
        title: "Project 5",
        description: "Description for Project 5.",
        image: "images/project1.jpg", // Ensure these images exist in your 'images' folder
        link: "https://github.com/username/project1"
    },
    {
        title: "Project 6",
        description: "Description for Project 6.",
        image: "images/project2.jpg",
        link: "https://github.com/username/project2"
    },
    // Add more projects as needed
    // ...
];

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
            endMessage.textContent = 'You have reached the end of the blog.';
            endMessage.style.textAlign = 'center';
            endMessage.style.marginTop = '20px';
            projectContainer.appendChild(endMessage);
        }
    });
}

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


document.getElementById('contact-form').addEventListener('submit', function(e) {
    e.preventDefault(); // Prevent the default form submission

    // Simple form validation
    const name = document.getElementById('name').value.trim();
    const email = document.getElementById('email').value.trim();
    const message = document.getElementById('message').value.trim();

    if (name === '' || email === '' || message === '') {
        document.getElementById('form-status').innerText = 'Please fill in all fields.';
        document.getElementById('form-status').style.color = 'red';
        return;
    }

    // Simulate form submission (since we don't have a backend)
    document.getElementById('form-status').innerText = 'Message sent successfully!';
    document.getElementById('form-status').style.color = 'green';

    // Reset the form
    document.getElementById('contact-form').reset();
});

// Get the button
const backToTopButton = document.getElementById('back-to-top');

// Function to show or hide the button based on scroll position
function toggleBackToTopButton() {
    // Show the button after scrolling down 300px
    if (window.scrollY > 300) {
        backToTopButton.classList.add('show');
    } else {
        backToTopButton.classList.remove('show');
    }
}

// Function to smoothly scroll to the top
function scrollToTop() {
    window.scrollTo({
        top: 0,
        behavior: 'smooth' // For smooth scrolling
    });
}

// Fade-In Effect Using Intersection Observer
document.addEventListener('DOMContentLoaded', function() {
    const faders = document.querySelectorAll('.fade-in');

    const appearOptions = {
        threshold: 0.1,
        rootMargin: "0px 0px -50px 0px"
    };

    const appearOnScroll = new IntersectionObserver(function(entries, observer) {
        entries.forEach(function(entry) {
            if (!entry.isIntersecting) {
                return;
            } else {
                entry.target.classList.add('visible');
                observer.unobserve(entry.target);
            }
        });
    }, appearOptions);

    faders.forEach(function(fader) {
        appearOnScroll.observe(fader);
    });
});

var images = [
    'image1.jpg',
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
setInterval(changeImage, 5000);

// Event listener for scroll to toggle button visibility
window.addEventListener('scroll', toggleBackToTopButton);

// Event listener for button click to scroll to top
backToTopButton.addEventListener('click', scrollToTop);
