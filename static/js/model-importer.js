import { map, dom, showLoader, hideLoader, firstSymbolId } from './main.js';
import { addImportedModelToList } from './main-model-manager.js';
import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';

const TARGET_MODEL_SIZE_METERS = 150;
const MAX_VERTICES_FOR_MAP = 1500000;

export function initializeModelImporter() {
    if (dom.importObjBtn) {
        dom.importObjBtn.onclick = handleModelImport;
    }
}

async function handleModelImport() {
    showLoader("Analyzing model file...");
    const objFile = dom.objFileInput.files[0];
    const mtlFile = dom.mtlFileInput.files[0];

    if (!objFile) {
        hideLoader();
        alert("A required .obj file must be selected.");
        return;
    }

    const allFiles = [objFile];
    if (mtlFile) allFiles.push(mtlFile);

    try {
        const fileMap = {};
        allFiles.forEach(file => fileMap[file.name] = URL.createObjectURL(file));
        
        const objLoader = new OBJLoader();
        const modelObject = await objLoader.loadAsync(fileMap[objFile.name]);
        
        let vertexCount = 0;
        modelObject.traverse(child => {
            if (child.isMesh) vertexCount += child.geometry.attributes.position.count;
        });
        
        console.log(`Model analyzed. Vertex count: ${vertexCount}`);
        Object.values(fileMap).forEach(URL.revokeObjectURL);

        showLoader("Uploading model files...");
        const formData = new FormData();
        allFiles.forEach(file => formData.append('files', file));
        
        const response = await fetch('/upload-model', { method: 'POST', body: formData });
        if (!response.ok) throw new Error(`Server responded with status: ${response.status}`);
        
        const result = await response.json();
        if (!result.success || !result.modelId) throw new Error(result.message || 'Failed to process model on server.');
        
        const modelId = result.modelId;

        if (vertexCount > MAX_VERTICES_FOR_MAP) {
            hideLoader();
            addImportedModelToList(objFile.name, `inspector-only-${modelId}`, null, modelId);
            alert(
                `Model is too large (${vertexCount.toLocaleString()} vertices) for map rendering.\n\n` +
                "It has been added to the 'Imported Models' list. Use the 'Inspect' button to view it."
            );
        } else {
            const origin = map.getCenter();
            origin.alt = map.queryTerrainElevation(origin, { exaggerated: false }) || 0;
            await renderAsCustomLayer(allFiles, origin, objFile.name, modelId, modelObject);
        }
    } catch(e) {
        alert("Error during import process: " + e.message);
        console.error("Model Import Error:", e);
        hideLoader();
    } finally {
        // Clear file inputs
        dom.objFileInput.value = '';
        dom.mtlFileInput.value = '';
    }
}

async function renderAsCustomLayer(files, origin, modelName, modelId, preloadedModelObject) {
    showLoader("Processing & Rendering Model...");
    const fileMap = {};
    files.forEach(file => fileMap[file.name] = URL.createObjectURL(file));
    const manager = new THREE.LoadingManager();
    manager.setURLModifier(url => fileMap[url.split('/').pop()] || url);

    const mtlFile = files.find(f => f.name.toLowerCase().endsWith('.mtl'));
    if (mtlFile) {
        const mtlLoader = new MTLLoader(manager);
        try {
            const materials = await mtlLoader.loadAsync(fileMap[mtlFile.name]);
            materials.preload();
            preloadedModelObject.traverse((child) => {
                if (child.isMesh && child.material) {
                    const materialName = Array.isArray(child.material) ? child.material[0].name : child.material.name;
                    if(materialName && materials.materials[materialName]) {
                        child.material = materials.materials[materialName];
                    }
                }
            });
        } catch (mtlError) {
            console.warn("Could not apply MTL materials:", mtlError);
        }
    }
    
    const box = new THREE.Box3().setFromObject(preloadedModelObject);
    const size = box.getSize(new THREE.Vector3());
    preloadedModelObject.position.y = -box.min.y;
    const maxDim = Math.max(size.x, size.y, size.z);
    const scale = maxDim > 0 ? TARGET_MODEL_SIZE_METERS / maxDim : 1;

    const modelLayer = createObjModelLayer(preloadedModelObject, origin, scale);
    map.addLayer(modelLayer, firstSymbolId);
    
    addImportedModelToList(modelName, modelLayer.id, null, modelId);
    zoomToModel(box, origin, scale);
    Object.values(fileMap).forEach(URL.revokeObjectURL);
    hideLoader();
}

function zoomToModel(box, origin, scale) {
    const modelOriginMercator = maplibregl.MercatorCoordinate.fromLngLat(origin);
    const meterScale = modelOriginMercator.meterInMercatorCoordinateUnits() * scale;
    const bounds = new maplibregl.LngLatBounds();
    const corners = [
        new THREE.Vector3(box.min.x, box.min.y, box.min.z), new THREE.Vector3(box.max.x, box.min.y, box.min.z),
        new THREE.Vector3(box.min.x, box.max.y, box.min.z), new THREE.Vector3(box.min.x, box.min.y, box.max.z),
        new THREE.Vector3(box.max.x, box.max.y, box.min.z), new THREE.Vector3(box.min.x, box.max.y, box.max.z),
        new THREE.Vector3(box.max.x, box.min.y, box.max.z), new THREE.Vector3(box.max.x, box.max.y, box.max.z),
    ];
    corners.forEach(corner => {
        const mercatorX = modelOriginMercator.x + corner.x * meterScale;
        const mercatorY = modelOriginMercator.y - corner.z * meterScale;
        bounds.extend(new maplibregl.MercatorCoordinate(mercatorX, mercatorY).toLngLat());
    });
    map.fitBounds(bounds, { padding: 100, pitch: 50, duration: 1500 });
}

function createObjModelLayer(model, origin, scale) {
    const modelAsMercator = maplibregl.MercatorCoordinate.fromLngLat({ lng: origin.lng, lat: origin.lat }, origin.alt);
    const modelTransform = {
        translateX: modelAsMercator.x, translateY: modelAsMercator.y, translateZ: modelAsMercator.z,
        rotateX: Math.PI / 2, rotateY: 0, rotateZ: 0,
        scale: modelAsMercator.meterInMercatorCoordinateUnits() * scale
    };

    return {
        id: '3d-model-layer-' + Date.now(),
        type: 'custom', renderingMode: '3d',
        onAdd: function (map, gl) {
            this.camera = new THREE.Camera();
            this.scene = new THREE.Scene();
            this.scene.add(new THREE.AmbientLight(0xffffff, 0.75));
            const dirLight = new THREE.DirectionalLight(0xffffff, 0.75);
            dirLight.position.set(0.5, -1, 1).normalize();
            this.scene.add(dirLight);
            this.scene.add(model);
            this.map = map;
            this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
            this.renderer.autoClear = false;
        },
        render: function (gl, matrix) {
            const rotationX = new THREE.Matrix4().makeRotationX(modelTransform.rotateX);
            const l = new THREE.Matrix4()
                .makeTranslation(modelTransform.translateX, modelTransform.translateY, modelTransform.translateZ)
                .scale(new THREE.Vector3(modelTransform.scale, -modelTransform.scale, modelTransform.scale))
                .multiply(rotationX);
            this.camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix).multiply(l);
            this.renderer.resetState();
            this.renderer.render(this.scene, this.camera);
            this.map.triggerRepaint();
        }
    };
}