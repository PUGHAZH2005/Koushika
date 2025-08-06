import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

// --- DOM ELEMENTS ---
const canvasContainer = document.getElementById('canvas-container');
const loadingIndicator = document.getElementById('loading-indicator');
const panelToggleBtn = document.getElementById('panel-toggle-btn');
const controlsPanel = document.getElementById('controls-panel');
const measureToolBtn = document.getElementById('measure-tool-btn');
const clearMeasurementsBtn = document.getElementById('clear-measurements-btn');
const toggleTextureBtn = document.getElementById('toggle-texture-btn');
const overallDimensionsBox = document.getElementById('overall-dimensions-box');

// --- 3D SCENE & MATERIALS ---
let scene, camera, renderer, labelRenderer, controls;
let model, allModelVertices = [];
const clayMaterial = new THREE.MeshPhongMaterial({ color: 0xcccccc, side: THREE.DoubleSide });
let originalMaterials = new Map();
let texturesVisible = true;

// --- CLIPPING & MEASUREMENT ---
const clipPlanes = [
    new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0),
    new THREE.Plane(new THREE.Vector3(0, -1, 0), 0),
    new THREE.Plane(new THREE.Vector3(0, 0, -1), 0)
];
let isMeasuring = false;
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const currentMeasurement = { points: [], markers: [], line: null, label: null };
const allMeasurements = [];
const SNAP_RADIUS = 0.15;
let snapIndicator;
const SNAP_COLORS = { MIDPOINT: 0x00aeff, VERTEX: 0x34c759 };

function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1e1e1e);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.localClippingEnabled = true;
    canvasContainer.appendChild(renderer.domElement);
    
    labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(window.innerWidth, window.innerHeight);
    labelRenderer.domElement.style.position = 'absolute';
    labelRenderer.domElement.style.top = '0px';
    labelRenderer.domElement.style.pointerEvents = 'none';
    canvasContainer.appendChild(labelRenderer.domElement);

    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 10000);
    camera.position.set(0, 2, 8);
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    scene.add(new THREE.AmbientLight(0xffffff, 1.5));
    const dirLight = new THREE.DirectionalLight(0xffffff, 2.0);
    dirLight.position.set(20, 30, 10);
    scene.add(dirLight);

    loadModel();
    setupUI();
    createSnapIndicator();

    window.addEventListener('resize', onWindowResize);
    canvasContainer.addEventListener('mousedown', onCanvasMouseDown);
    canvasContainer.addEventListener('mousemove', onCanvasMouseMove);

    animate();
}

function loadModel() {
    const { objPath, mtlPath } = window.MODEL_DATA;
    loadingIndicator.style.display = 'flex';

    const objLoader = new OBJLoader();

    if (mtlPath) {
        const mtlLoader = new MTLLoader();
        mtlLoader.load(mtlPath, (materials) => {
            materials.preload();
            objLoader.setMaterials(materials);
            objLoader.load(objPath, (model) => onModelLoaded(model, false), onProgress, onModelLoadError);
        }, undefined, (error) => {
            console.warn("MTL file failed to load. Loading OBJ with default material.", error);
            objLoader.load(objPath, (model) => onModelLoaded(model, true), onProgress, onModelLoadError);
        });
    } else {
        objLoader.load(objPath, (model) => onModelLoaded(model, true), onProgress, onModelLoadError);
    }
}

function onProgress(xhr) {
    if (xhr.lengthComputable) {
        const percentComplete = Math.round((xhr.loaded / xhr.total) * 100);
        loadingIndicator.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Loading Model... ${percentComplete}%`;
    }
}

function onModelLoaded(loadedModel, forceDefaultMaterial) {
    loadingIndicator.style.display = 'none';
    model = loadedModel;

    model.traverse((child) => {
        if (child.isMesh) {
            if (!child.geometry.attributes.normal) child.geometry.computeVertexNormals();
            if (forceDefaultMaterial || !child.material) child.material = clayMaterial;
            originalMaterials.set(child.uuid, child.material);
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            materials.forEach(m => {
                m.clippingPlanes = clipPlanes;
                m.side = THREE.DoubleSide;
            });
        }
    });

    const bbox = new THREE.Box3().setFromObject(model);
    if (bbox.isEmpty()) {
        onModelLoadError({ message: "Could not compute bounding box. Model may be empty." });
        return;
    }
    const center = bbox.getCenter(new THREE.Vector3());
    model.position.sub(center);
    const scale = 5 / Math.max(...bbox.getSize(new THREE.Vector3()).toArray());
    model.scale.set(scale, scale, scale);

    const scaledBbox = new THREE.Box3().setFromObject(model);
    const boundingSphere = scaledBbox.getBoundingSphere(new THREE.Sphere());
    camera.near = Math.max(0.001, boundingSphere.radius / 1000);
    camera.far = (boundingSphere.radius + camera.position.length()) * 5;
    camera.updateProjectionMatrix();
    
    allModelVertices = [];
    model.traverse(child => {
        if (child.isMesh && child.geometry.attributes.position) {
            const positions = child.geometry.attributes.position;
            for (let i = 0; i < positions.count; i++) {
                allModelVertices.push(new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(child.matrixWorld));
            }
        }
    });
    
    const scaledModelSize = scaledBbox.getSize(new THREE.Vector3());
    displayOverallDimensions(scaledModelSize);

    scene.add(model);
    setupClippingControls(scaledModelSize);
}

function onModelLoadError(error) {
    loadingIndicator.style.display = 'none';
    console.error("Failed to load or process model:", error);
    alert(`Error: Could not load the model. ${error.message}. Check console for details.`);
}

function displayOverallDimensions(size) {
    overallDimensionsBox.innerHTML = `
        <p><span class="dim-label">Length (X):</span> ${size.x.toFixed(3)} u</p>
        <p><span class="dim-label">Height (Y):</span> ${size.y.toFixed(3)} u</p>
        <p><span class="dim-label">Width (Z):</span> ${size.z.toFixed(3)} u</p>
    `;
}

function setupUI() {
    panelToggleBtn.addEventListener('click', () => {
        controlsPanel.classList.toggle('collapsed');
        panelToggleBtn.classList.toggle('open');
    });
    setTimeout(() => {
        controlsPanel.classList.remove('collapsed');
        panelToggleBtn.classList.add('open');
    }, 500);

    measureToolBtn.addEventListener('click', toggleMeasurementMode);
    clearMeasurementsBtn.addEventListener('click', clearAllMeasurements);
    toggleTextureBtn.addEventListener('click', toggleTextures);
}

function toggleTextures() {
    texturesVisible = !texturesVisible;
    clayMaterial.clippingPlanes = clipPlanes;
    model.traverse((child) => {
        if (child.isMesh) {
            child.material = texturesVisible ? originalMaterials.get(child.uuid) : clayMaterial;
        }
    });
    toggleTextureBtn.textContent = texturesVisible ? 'Hide Textures' : 'Show Textures';
}

function setupClippingControls(modelSize) {
    const planeColors = [0xff0000, 0x00ff00, 0x0000ff];
    const helperSize = Math.max(...modelSize.toArray()) * 1.5;
    clipPlanes.forEach((plane, i) => {
        const helper = new THREE.PlaneHelper(plane, helperSize, planeColors[i]);
        scene.add(helper);
        const slider = document.getElementById(['clip-x', 'clip-y', 'clip-z'][i]);
        slider.addEventListener('input', e => {
            plane.constant = (modelSize.getComponent(i) / 2) * parseFloat(e.target.value);
        });
        plane.constant = modelSize.getComponent(i) / 2;
    });
}

function createSnapIndicator() {
    const geo = new THREE.SphereGeometry(0.07, 16, 16);
    const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.8, depthTest: false });
    snapIndicator = new THREE.Mesh(geo, mat);
    snapIndicator.visible = false;
    snapIndicator.renderOrder = 3;
    scene.add(snapIndicator);
}

function toggleMeasurementMode() {
    isMeasuring = !isMeasuring;
    measureToolBtn.classList.toggle('active', isMeasuring);
    canvasContainer.classList.toggle('measuring', isMeasuring);
    controls.enabled = !isMeasuring;
    if (!isMeasuring) {
        clearCurrentMeasurement();
        snapIndicator.visible = false;
    }
}

function onCanvasMouseMove(event) {
    if (!isMeasuring || !model) return;
    const rect = canvasContainer.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    const snapResult = getSnapPoint(mouse);
    if (snapResult) {
        snapIndicator.visible = true;
        snapIndicator.position.copy(snapResult.point);
        snapIndicator.material.color.set(SNAP_COLORS[snapResult.type]);
    } else {
        snapIndicator.visible = false;
    }
}

function onCanvasMouseDown(event) {
    if (!isMeasuring || !model || event.button !== 0) return;
    const snapResult = getSnapPoint(mouse);
    if (!snapResult) return;
    const clickPoint = snapResult.point;
    currentMeasurement.points.push(clickPoint.clone());
    addMeasurementMarker(clickPoint);
    if (currentMeasurement.points.length === 2) {
        drawMeasurementLine();
        const distance = currentMeasurement.points[0].distanceTo(currentMeasurement.points[1]);
        addMeasurementLabel(distance);
        allMeasurements.push({ ...currentMeasurement });
        clearCurrentMeasurement(false);
    }
}

function getSnapPoint(mouseCoords) {
    const closestVertex = { dist: Infinity, point: null };
    for (const vertex of allModelVertices) {
        const screenPos = vertex.clone().project(camera);
        const dist = new THREE.Vector2(screenPos.x, screenPos.y).distanceTo(mouseCoords);
        if (dist < SNAP_RADIUS && dist < closestVertex.dist) {
            closestVertex.dist = dist;
            closestVertex.point = vertex;
        }
    }
    if (closestVertex.point) return { point: closestVertex.point, type: 'VERTEX' };
    raycaster.setFromCamera(mouseCoords, camera);
    const intersects = raycaster.intersectObject(model, true);
    if (intersects.length > 0) return { point: intersects[0].point, type: 'MIDPOINT' };
    return null;
}

function addMeasurementMarker(position) {
    const markerGeometry = new THREE.SphereGeometry(0.03);
    const markerMaterial = new THREE.MeshBasicMaterial({ color: 0xff4500, toneMapped: false, depthTest: false });
    const marker = new THREE.Mesh(markerGeometry, markerMaterial);
    marker.position.copy(position);
    marker.renderOrder = 2;
    scene.add(marker);
    currentMeasurement.markers.push(marker);
}

function drawMeasurementLine() {
    const lineMaterial = new THREE.LineDashedMaterial({
        color: 0xff4500, dashSize: 0.1, gapSize: 0.05, depthTest: false,
    });
    const lineGeometry = new THREE.BufferGeometry().setFromPoints(currentMeasurement.points);
    const line = new THREE.Line(lineGeometry, lineMaterial);
    line.computeLineDistances();
    line.renderOrder = 1;
    scene.add(line);
    currentMeasurement.line = line;
}

function addMeasurementLabel(distance) {
    const midPoint = new THREE.Vector3().addVectors(currentMeasurement.points[0], currentMeasurement.points[1]).multiplyScalar(0.5);
    const labelDiv = document.createElement('div');
    labelDiv.className = 'measurement-label';
    labelDiv.textContent = `${distance.toFixed(3)} u`;
    const label = new CSS2DObject(labelDiv);
    label.position.copy(midPoint);
    scene.add(label);
    currentMeasurement.label = label;
}

function clearCurrentMeasurement(resetPoints = true) {
    if (resetPoints) currentMeasurement.points = [];
    currentMeasurement.markers.forEach(m => scene.remove(m));
    currentMeasurement.markers = [];
    if (currentMeasurement.line) scene.remove(currentMeasurement.line);
    currentMeasurement.line = null;
    if (currentMeasurement.label) scene.remove(currentMeasurement.label);
    currentMeasurement.label = null;
}

function clearAllMeasurements() {
    allMeasurements.forEach(meas => {
        meas.markers.forEach(m => scene.remove(m));
        if (meas.line) scene.remove(meas.line);
        if (meas.label) scene.remove(meas.label);
    });
    allMeasurements.length = 0;
    clearCurrentMeasurement();
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    labelRenderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
}

init();