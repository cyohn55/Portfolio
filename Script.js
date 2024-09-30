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

// Modify your DOMContentLoaded event listener to include Three.js initialization
document.addEventListener('DOMContentLoaded', () => {
    loadProjects(); // Initial load
    window.addEventListener('scroll', handleScroll);

    // Initialize the Three.js scene
    initThreeJSScene();
});

// Function to initialize the Three.js scene and load the glTF model
function initThreeJSScene() {
    // Get the container element
    const container = document.getElementById('model-container');

    // Check if the container exists
    if (!container) {
        console.error('No container element found for the 3D model.');
        return;
    }

    // Create the scene
    const scene = new THREE.Scene();

    // Set up the camera
    const camera = new THREE.PerspectiveCamera(
        75, // Field of view
        container.clientWidth / container.clientHeight, // Aspect ratio
        0.1, // Near clipping plane
        1000 // Far clipping plane
    );

    // Position the camera
    camera.position.z = 5;

    // Set up the renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    // Add ambient light
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    // Add directional light
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(0, 10, 10);
    scene.add(directionalLight);

    // Load the glTF model
    const loader = new THREE.GLTFLoader();

    // Declare 'model' in a scope accessible to both loader and animate function
    let model;

    loader.load(
        'models/your-model.gltf', // Replace with the correct path to your model
        function (gltf) {
            model = gltf.scene;
            scene.add(model);

            // Optionally, scale or position the model
            // model.scale.set(0.5, 0.5, 0.5);
            // model.position.set(0, 0, 0);

            // Start the animation loop
            animate();
        },
        undefined,
        function (error) {
            console.error('An error occurred while loading the model', error);
        }
    );

    // Handle window resize
    window.addEventListener('resize', onWindowResize, false);
    function onWindowResize() {
        camera.aspect = container.clientWidth / container.clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(container.clientWidth, container.clientHeight);
    }

    // Animation loop
    function animate() {
        requestAnimationFrame(animate);

        // Optional: Add rotation or other animations to the model
        if (model) {
            model.rotation.y += 0.01;
        }

        renderer.render(scene, camera);
    }
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





