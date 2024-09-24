// script.js

const projectsPerLoad = 6; // Number of projects to load each time
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
    {
        title: "Project 7",
        description: "Description for Project 7.",
        image: "images/project1.jpg", // Ensure these images exist in your 'images' folder
        link: "https://github.com/username/project1"
    },
    {
        title: "Project 8",
        description: "Description for Project 8.",
        image: "images/project2.jpg",
        link: "https://github.com/username/project2"
    },
    {
        title: "Project 9",
        description: "Description for Project 9.",
        image: "images/project1.jpg", // Ensure these images exist in your 'images' folder
        link: "https://github.com/username/project1"
    },
    {
        title: "Project 10",
        description: "Description for Project 10.",
        image: "images/project2.jpg",
        link: "https://github.com/username/project2"
    },
    {
        title: "Project 11",
        description: "Description for Project 11.",
        image: "images/project1.jpg", // Ensure these images exist in your 'images' folder
        link: "https://github.com/username/project1"
    },
    {
        title: "Project 12",
        description: "Description for Project 12.",
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
            endMessage.textContent = 'You have reached the end of the projects.';
            endMessage.style.textAlign = 'center';
            endMessage.style.marginTop = '20px';
            projectContainer.appendChild(endMessage);
        }
    }, 1000); // 1-second delay to simulate loading
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

