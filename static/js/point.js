import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// --- DOM ELEMENTS ---
const dom = {
    canvasContainer: document.getElementById('canvas-container'),
    inspectorToolBtn: document.getElementById('inspector-tool-btn'),
    controlsPanel: document.getElementById('controls-panel'),
    closeInspectorBtn: document.getElementById('close-inspector-btn'),
    pcSelect: document.getElementById('pc-select'),
    colorizeSelect: document.getElementById('colorize-select'),
    pointSizeSlider: document.getElementById('point-size-slider'),
    pointSizeValue: document.getElementById('point-size-value'),
    resetViewBtn: document.getElementById('reset-view-btn'),
    measureToolBtn: document.getElementById('measure-tool-btn'),
    profileToolBtn: document.getElementById('profile-tool-btn'),
    clearToolsBtn: document.getElementById('clear-tools-btn'),
    infoPanel: document.getElementById('info-panel'),
    measurementInfo: document.getElementById('measurement-info'),
    hintPanel: document.getElementById('hint-panel'),
    profilePopup: document.getElementById('profile-popup'),
    profileChartCanvas: document.getElementById('profile-chart'),
    profileStats: document.getElementById('profile-stats'),
    loadingOverlay: document.getElementById('loading-overlay'),
    loaderText: document.getElementById('loader-text'),
};

// --- 3D SCENE & APP STATE ---
let scene, camera, renderer, controls, raycaster;
let pointCloud, pointMaterial, circleTexture;
let currentPointCloudData = null; // Stores metadata
let activeTool = null; // 'measure' or 'profile'

// Tool-specific state
let measurementState = { points: [], markers: [], line: null };
let profileState = { points: [], markers: [], line: null };
let profileChartInstance = null;
let profileMarker = null;

// --- NEW: Snapping variables ---
let snapIndicator;
const mouse = new THREE.Vector2();

document.addEventListener('DOMContentLoaded', initialize);

function initialize() {
    initThree();
    setupEventListeners();
    populateLayerSelect();
}

function initThree() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1c1c1e);

    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 10000);
    camera.position.set(0, 0, 150);
    scene.add(camera);
    
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    dom.canvasContainer.appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.screenSpacePanning = true; 
    controls.minPolarAngle = 0;
    controls.maxPolarAngle = Math.PI;
    
    controls.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN
    };

    raycaster = new THREE.Raycaster();
    raycaster.params.Points.threshold = 1.0; 

    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 128;
    const context = canvas.getContext('2d');
    context.beginPath();
    context.arc(64, 64, 60, 0, 2 * Math.PI);
    context.fillStyle = 'white';
    context.fill();
    circleTexture = new THREE.CanvasTexture(canvas);

    // --- NEW: Create the snap indicator sphere ---
    const snapGeom = new THREE.SphereGeometry(0.7, 16, 16);
    const snapMat = new THREE.MeshBasicMaterial({ color: 0x00ff00, transparent: true, opacity: 0.5 });
    snapIndicator = new THREE.Mesh(snapGeom, snapMat);
    snapIndicator.visible = false;
    scene.add(snapIndicator);

    const ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
    scene.add(ambientLight);

    window.addEventListener('resize', onWindowResize);
    dom.canvasContainer.addEventListener('click', onCanvasClick, false);
    dom.canvasContainer.addEventListener('dblclick', onCanvasDoubleClick, false);
    // --- NEW: Add mousemove listener for snapping ---
    dom.canvasContainer.addEventListener('mousemove', onCanvasMouseMove, false);
    animate();
}

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function setupEventListeners() {
    dom.inspectorToolBtn.addEventListener('click', () => dom.controlsPanel.classList.toggle('visible'));
    dom.closeInspectorBtn.addEventListener('click', () => dom.controlsPanel.classList.remove('visible'));
    dom.pcSelect.addEventListener('change', handleLayerChange);
    dom.colorizeSelect.addEventListener('change', handleColorizeChange);
    dom.pointSizeSlider.addEventListener('input', handlePointSizeChange);
    dom.resetViewBtn.addEventListener('click', resetView);
    dom.measureToolBtn.addEventListener('click', () => toggleTool('measure'));
    dom.profileToolBtn.addEventListener('click', () => toggleTool('profile'));
    dom.clearToolsBtn.addEventListener('click', clearAllToolMarkings);
    
    dom.profilePopup.querySelector('.close-popup-btn').addEventListener('click', () => {
        dom.profilePopup.classList.remove('visible');
        if (profileMarker) profileMarker.visible = false;
        if (profileChartInstance) {
            profileChartInstance.destroy();
            profileChartInstance = null;
        }
    });
}

async function populateLayerSelect() {
    showLoader("Fetching layer list...");
    try {
        const layers = await fetch('/api/pointcloud_layers').then(res => res.json());
        dom.pcSelect.innerHTML = `<option value="">-- Select a Layer --</option>`;
        if (layers.length > 0) {
            layers.forEach(layer => dom.pcSelect.appendChild(new Option(layer.name, layer.id)));
        } else {
            dom.pcSelect.innerHTML = `<option value="">-- No Layers Found --</option>`;
            dom.pcSelect.disabled = true;
        }
    } catch (error) {
        console.error("Failed to populate layers:", error);
        alert("Could not load layer list.");
    } finally {
        hideLoader();
    }
}

async function handleLayerChange() {
    const filename = dom.pcSelect.value;
    clearScene();
    if (!filename) return;

    showLoader(`Fetching metadata for ${filename}...`);
    try {
        const metaResponse = await fetch(`/api/get_pointcloud_metadata/${encodeURIComponent(filename)}`);
        if (!metaResponse.ok) {
            const error = await metaResponse.json();
            throw new Error(error.error || `Server error: ${metaResponse.status}`);
        }
        currentPointCloudData = await metaResponse.json();

        showLoader(`Loading ${currentPointCloudData.point_count.toLocaleString()} points...`);
        await createPointCloudFromStream(currentPointCloudData);
        
        updateUIOnLoad(currentPointCloudData);
        resetView();

    } catch (error) {
        alert(`Failed to load point cloud: ${error.message}`);
        console.error(error);
        clearScene();
    } finally {
        hideLoader();
    }
}

async function createPointCloudFromStream(meta) {
    const fileLoader = new THREE.FileLoader();
    fileLoader.setResponseType('arraybuffer');

    const positionBuffer = await fileLoader.loadAsync(`/api/get_pointcloud_data/${meta.files.positions}`);
    const positions = new Float32Array(positionBuffer);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    pointMaterial = new THREE.PointsMaterial({
        size: parseFloat(dom.pointSizeSlider.value),
        vertexColors: true,
        sizeAttenuation: true,
        map: circleTexture,
        alphaTest: 0.5,
        transparent: true,
    });

    pointCloud = new THREE.Points(geometry, pointMaterial);
    scene.add(pointCloud);

    meta.files.colors_loaded = {};
    for (const attr of meta.color_attributes) {
        const colorBuffer = await fileLoader.loadAsync(`/api/get_pointcloud_data/${meta.files.colors[attr]}`);
        meta.files.colors_loaded[attr] = new Float32Array(colorBuffer);
    }

    dom.colorizeSelect.innerHTML = '';
    meta.color_attributes.forEach(attr => {
        const name = attr.charAt(0).toUpperCase() + attr.slice(1);
        dom.colorizeSelect.add(new Option(name, attr));
    });
    handleColorizeChange();
}

function handleColorizeChange() {
    if (!pointCloud || !currentPointCloudData) return;
    const mode = dom.colorizeSelect.value;
    const colors = currentPointCloudData.files.colors_loaded[mode];
    if (colors) {
        pointCloud.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
}

function handlePointSizeChange() {
    const newSize = parseFloat(dom.pointSizeSlider.value);
    dom.pointSizeValue.textContent = newSize.toFixed(1);
    if (pointMaterial) {
        pointMaterial.size = newSize;
    }
}

// --- Tools Logic ---

function toggleTool(toolName) {
    if (activeTool === toolName) {
        activeTool = null;
    } else {
        if (activeTool) {
            clearAllToolMarkings();
        }
        activeTool = toolName;
    }
    
    // --- CHANGE: Hide snap indicator when no tool is active ---
    if (!activeTool) {
        snapIndicator.visible = false;
    }

    const isToolActive = !!activeTool;
    controls.enableRotate = !isToolActive;
    controls.enablePan = !isToolActive;
    controls.enableZoom = !isToolActive;

    if (isToolActive) {
        const toolDisplayName = activeTool.charAt(0).toUpperCase() + activeTool.slice(1);
        dom.hintPanel.innerHTML = `<strong>${toolDisplayName} Tool Active:</strong> Click to add points. Double-click to finish.`;
        dom.hintPanel.style.display = 'block';
    } else {
        dom.hintPanel.style.display = 'none';
        dom.measurementInfo.style.display = 'none';
    }
    
    updateToolButtons();
}

function updateToolButtons() {
    dom.measureToolBtn.classList.toggle('active', activeTool === 'measure');
    dom.profileToolBtn.classList.toggle('active', activeTool === 'profile');
    dom.canvasContainer.classList.toggle('crosshair-cursor', !!activeTool);
}

// --- NEW: Snapping logic on mouse move ---
function onCanvasMouseMove(event) {
    if (!activeTool || !pointCloud) {
        snapIndicator.visible = false;
        return;
    }

    const rect = dom.canvasContainer.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(pointCloud);

    if (intersects.length > 0) {
        const intersection = intersects[0];
        const pointIndex = intersection.index;
        
        // Get the precise coordinates of the snapped point using its index
        const positionAttribute = pointCloud.geometry.attributes.position;
        const snappedPoint = new THREE.Vector3();
        snappedPoint.fromBufferAttribute(positionAttribute, pointIndex);

        snapIndicator.position.copy(snappedPoint);
        snapIndicator.visible = true;
    } else {
        snapIndicator.visible = false;
    }
}


function onCanvasClick(event) {
    // --- CHANGE: Use the snap indicator's position instead of a new raycast ---
    if (event.button !== 0 || !activeTool || !pointCloud || !snapIndicator.visible) return;
    
    const point = snapIndicator.position.clone(); // Use the snapped point
    
    if (activeTool === 'measure') {
        handleMeasureClick(point);
    } else if (activeTool === 'profile') {
        handleProfileClick(point);
    }
}

function onCanvasDoubleClick(event) {
    if (!activeTool) return;
    event.preventDefault();

    if (activeTool === 'profile' && profileState.points.length >= 2) {
        generateProfile();
    }
}

function handleMeasureClick(point) {
    if (measurementState.points.length >= 2) clearMeasurement();
    addMarker(point, measurementState.markers, 0xffff00);
    measurementState.points.push(point);
    if (measurementState.points.length === 2) {
        measurementState.line = drawLine(measurementState.points, 0xffff00, true);
        updateMeasurementDisplay();
        toggleTool(null);
    }
}

function handleProfileClick(point) {
    addMarker(point, profileState.markers, 0xca0000);
    profileState.points.push(point);
    if (profileState.line) scene.remove(profileState.line);
    if (profileState.points.length >= 2) {
        profileState.line = drawLine(profileState.points, 0xca0000, false);
    }
}

function generateProfile() {
    if (profileState.points.length < 2) return;
    const profileData = [];
    let cumulativeDistance = 0;
    profileData.push({ distance: 0, point: profileState.points[0] });
    for (let i = 1; i < profileState.points.length; i++) {
        const p1 = profileState.points[i-1];
        const p2 = profileState.points[i];
        const horizontalDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        cumulativeDistance += horizontalDist;
        profileData.push({ distance: cumulativeDistance, point: p2 });
    }
    displayProfileChart(profileData);
    // After generating the chart, we can clear the markings from the 3D view.
    // The user can still see the profile in the chart popup.
    clearProfile();
    toggleTool(null);
}

function displayProfileChart(profileData) {
    dom.profilePopup.classList.add('visible');
    const stats = calculateProfileStats(profileData);
    if (stats) {
        dom.profileStats.innerHTML = `<span>Range: <strong>${stats.totalDistance} m</strong></span><span>Min/Avg/Max: <strong>${stats.minElev}m / ${stats.avgElev}m / ${stats.maxElev}m</strong></span><span>Gain/Loss: <strong>+${stats.totalGain}m / -${stats.totalLoss}m</strong></span><span>Max Slope: <strong>${stats.maxSlope}%</strong></span>`;
    }
    if (profileChartInstance) profileChartInstance.destroy();
    const verticalLinePlugin = { id: 'verticalLine', afterDraw: chart => { if (chart.tooltip?.active?.length) { const ctx = chart.ctx; ctx.save(); const x = chart.tooltip.active[0].element.x; const topY = chart.scales.y.top; const bottomY = chart.scales.y.bottom; ctx.beginPath(); ctx.moveTo(x, topY); ctx.lineTo(x, bottomY); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(150, 150, 150, 0.7)'; ctx.stroke(); ctx.restore(); }}};
    profileChartInstance = new Chart(dom.profileChartCanvas, { type: 'line', data: { labels: profileData.map(p => p.distance.toFixed(1)), datasets: [{ label: 'Elevation', data: profileData.map(p => p.point.z), borderColor: '#ca0000', backgroundColor: 'rgba(202, 0, 0, 0.2)', fill: true, tension: 0.1, pointRadius: 0 }] }, options: { responsive: true, maintainAspectRatio: false, interaction: { intersect: false, mode: 'index' }, scales: { x: { title: { display: true, text: 'Distance (m)' } }, y: { title: { display: true, text: 'Elevation (m)' } } }, plugins: { legend: { display: false }, tooltip: { enabled: true, callbacks: { title: (tooltipItems) => `Distance: ${tooltipItems[0].label} m` } }, verticalLine: true, }, onHover: (event, chartElements) => { if (chartElements.length === 0) { if (profileMarker) profileMarker.visible = false; return; } const index = chartElements[0].index; const dataPoint = profileData[index]; if(dataPoint) updateProfileMarker3D(dataPoint.point); }, }, plugins: [verticalLinePlugin] });
}

function calculateProfileStats(profileData) {
    if (profileData.length < 2) return null;
    let totalGain = 0, totalLoss = 0, maxSlope = 0;
    const elevations = profileData.map(p => p.point.z);
    const minElev = Math.min(...elevations);
    const maxElev = Math.max(...elevations);
    const avgElev = elevations.reduce((a, b) => a + b, 0) / elevations.length;
    for (let i = 1; i < profileData.length; i++) {
        const p1 = profileData[i - 1];
        const p2 = profileData[i];
        const elevDiff = p2.point.z - p1.point.z;
        (elevDiff > 0) ? totalGain += elevDiff : totalLoss += Math.abs(elevDiff);
        const distDiff = p2.distance - p1.distance;
        if (distDiff > 0.001) maxSlope = Math.max(maxSlope, Math.abs(elevDiff / distDiff) * 100);
    }
    return { minElev: minElev.toFixed(1), maxElev: maxElev.toFixed(1), avgElev: avgElev.toFixed(1), totalGain: totalGain.toFixed(1), totalLoss: totalLoss.toFixed(1), maxSlope: maxSlope.toFixed(1), totalDistance: (profileData[profileData.length-1].distance).toFixed(2), };
}

function updateMeasurementDisplay() {
    dom.measurementInfo.style.display = 'block';
    const [p1, p2] = measurementState.points;
    const dist3D = p1.distanceTo(p2);
    const dist2D = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const distZ = Math.abs(p2.z - p1.z);
    dom.measurementInfo.innerHTML = `<strong>3D Dist:</strong> ${dist3D.toFixed(2)} m | <strong>Horiz:</strong> ${dist2D.toFixed(2)} m | <strong>Height:</strong> ${distZ.toFixed(2)} m`;
}

function updateProfileMarker3D(position) {
    if (!profileMarker) { const markerGeom = new THREE.SphereGeometry(0.8, 16, 16); const markerMat = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true }); profileMarker = new THREE.Mesh(markerGeom, markerMat); profileMarker.visible = false; scene.add(profileMarker); }
    profileMarker.position.copy(position);
    profileMarker.visible = true;
}

function addMarker(position, markerArray, color = 0xffff00) {
    const markerGeom = new THREE.SphereGeometry(0.5, 16, 16); const markerMat = new THREE.MeshBasicMaterial({ color }); const marker = new THREE.Mesh(markerGeom, markerMat); marker.position.copy(position); scene.add(marker); markerArray.push(marker);
}

function drawLine(points, color = 0xffff00, isDashed = false) {
    const material = isDashed ? new THREE.LineDashedMaterial({ color, dashSize: 0.5, gapSize: 0.25, linewidth: 2 }) : new THREE.LineBasicMaterial({ color, linewidth: 2 });
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(geometry, material);
    if (isDashed) line.computeLineDistances();
    scene.add(line);
    return line;
}

function clearMeasurement() {
    measurementState.markers.forEach(m => scene.remove(m));
    if (measurementState.line) scene.remove(measurementState.line);
    measurementState = { points: [], markers: [], line: null };
    if (activeTool !== 'profile') dom.measurementInfo.style.display = 'none';
}

function clearProfile() {
    profileState.markers.forEach(m => scene.remove(m));
    if (profileState.line) scene.remove(profileState.line);
    if (profileMarker) profileMarker.visible = false;
    profileState = { points: [], markers: [], line: null };
    if (activeTool !== 'measure') dom.measurementInfo.style.display = 'none';
}

function clearAllToolMarkings() {
    clearMeasurement();
    clearProfile();
}

function clearScene() {
    if (pointCloud) { scene.remove(pointCloud); pointCloud.geometry.dispose(); pointCloud.material.dispose(); pointCloud = null; currentPointCloudData = null; }
    clearAllToolMarkings();
    const controlsToDisable = [ dom.colorizeSelect, dom.pointSizeSlider, dom.resetViewBtn, dom.measureToolBtn, dom.profileToolBtn, dom.clearToolsBtn ];
    controlsToDisable.forEach(el => el.disabled = true);
    dom.colorizeSelect.innerHTML = '';
    dom.infoPanel.style.display = 'none';
    if(activeTool) toggleTool(null);
}

function updateUIOnLoad(meta) {
    const controlsToEnable = [ dom.colorizeSelect, dom.pointSizeSlider, dom.resetViewBtn, dom.measureToolBtn, dom.profileToolBtn, dom.clearToolsBtn ];
    controlsToEnable.forEach(el => el.disabled = false);
    dom.infoPanel.style.display = 'block';
    const min = meta.bbox.min;
    const max = meta.bbox.max;
    const sizeX = (max[0] - min[0]).toFixed(1);
    const sizeY = (max[1] - min[1]).toFixed(1);
    const sizeZ = (max[2] - min[2]).toFixed(1);
    dom.infoPanel.innerHTML = `<strong>Points:</strong> ${meta.point_count.toLocaleString()}<br><strong>Size (X,Y,Z):</strong> ${sizeX}m, ${sizeY}m, ${sizeZ}m`;
}

function resetView() {
    if (!pointCloud) return;
    pointCloud.geometry.computeBoundingSphere();
    const sphere = pointCloud.geometry.boundingSphere;
    const center = sphere.center;
    const radius = sphere.radius;
    const fov = camera.fov * (Math.PI / 180);
    const distance = Math.abs(radius / Math.sin(fov / 2));
    const direction = new THREE.Vector3();
    camera.getWorldDirection(direction);
    if (direction.lengthSq() === 0) { direction.set(0, 0, 1); }
    camera.position.copy(direction.multiplyScalar(-distance).add(center));
    controls.target.copy(center);
    camera.near = distance * 0.01;
    camera.far = distance * 2;
    camera.updateProjectionMatrix();
    controls.update();
}

function showLoader(text) {
    dom.loaderText.textContent = text;
    dom.loadingOverlay.style.display = 'flex';
}

function hideLoader() {
    dom.loadingOverlay.style.display = 'none';
}