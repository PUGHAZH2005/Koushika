import { setupUI, setupEventListeners } from './ui.js';
import { populateLayerList, handleDemChange, handleVectorToggle, handleRasterToggle } from './layer-handlers.js';
import { initializeModelImporter } from './model-importer.js';

// --- Global State & Constants ---
export const state = {
    currentDEM: null,
    activeLayers: {},
    isMeasuring: false,
    isProfiling: false,
    measurePoints: [],
    profilePoints: [],
    highlightedFeature: { layerId: null, featureId: null },
};

// --- FIX: Declare dom here, but assign it after the document loads ---
export let dom; 

export let map;
export let firstSymbolId = null;
export let currentPopup = null;
export let profileChart = null;

export function setProfileChart(chart) { profileChart = chart; }
export function setCurrentPopup(popup) { currentPopup = popup; }

// --- Initialization ---
document.addEventListener("DOMContentLoaded", function () {
    // --- FIX: Populate the dom object *inside* the listener ---
    // This guarantees all HTML elements exist before we try to select them.
    dom = {
        // Left Toolbar & Panels
        leftSidebar: document.getElementById("left-sidebar"),
        layersPanel: document.getElementById("layers-panel"),
        layersTool: document.getElementById("layers-tool"),
        closeLayersPanelBtn: document.getElementById("close-layers-panel-btn"),
        hazardPanel: document.getElementById("hazard-panel"),
        hazardToolBtn: document.getElementById("hazard-tool-btn"),
        closeHazardPanelBtn: document.getElementById("close-hazard-panel-btn"),

        // Right Toolbar & Panel
        rightSidebar: document.getElementById("right-sidebar"),
        viewOptionsPanel: document.getElementById("view-options-panel"),
        viewOptionsTool: document.getElementById("view-options-tool"),
        closeViewOptionsPanelBtn: document.getElementById("close-view-options-panel-btn"),

        // Tools
        attributesTool: document.getElementById("attributes-tool"),
        measureTool: document.getElementById("measure-tool"),
        profileTool: document.getElementById("profile-tool"),
        downloadPdfBtn: document.getElementById("download-pdf-btn"),

        // Layer Lists
        demList: document.getElementById("dem-layer-list"),
        vectorList: document.getElementById("vector-layer-list"),
        rasterList: document.getElementById("raster-layer-list"),

        // View Options (in Right Panel)
        labelControlGroup: document.getElementById("label-control-group"),
        labelLayerSelect: document.getElementById("label-layer-select"),
        labelFieldSelect: document.getElementById("label-field-select"),
        basemapRadios: document.querySelectorAll('input[name="basemap"]'),
        
        // Analysis and Generated Layers
        analysisLayerList: document.getElementById("analysis-layer-list"),
        analysisLayersPlaceholder: document.getElementById("analysis-layers-placeholder"),
        hazardRainfallInput: document.getElementById("hazard-rainfall-input"),
        calculateSlopeBtn: document.getElementById("calculate-slope-btn"),
        calculateAspectBtn: document.getElementById("calculate-aspect-btn"),
        analyzeLandslideBtn: document.getElementById("analyze-landslide-btn"),
        
        // Other UI
        loadingOverlay: document.getElementById("loading-overlay"),
        loaderText: document.getElementById("loader-text"),
        elevationInfo: document.getElementById("elevation-info"),
        measureInfo: document.getElementById("measure-info"),
        infoPanels: document.getElementById('info-panels'),
        profileContainer: document.getElementById("profile-container"),
        profileChartCanvas: document.getElementById('profile-chart'),
        profileStats: document.getElementById('profile-stats'),
        closeProfileBtn: document.getElementById("close-profile-btn"),
        attributePanel: document.getElementById("attribute-panel"), 
        attributeTablesContainer: document.getElementById('attribute-tables-container'),
        closeAttributePanelBtn: document.getElementById('close-attribute-panel-btn'),
        legendContainer: document.getElementById("legend-container"),
        legendContent: document.getElementById("legend-content"),
        
        // Model Importer
        importObjBtn: document.getElementById("import-obj-btn"),
        objFileInput: document.getElementById("obj-file-input"),
        mtlFileInput: document.getElementById("mtl-file-input"),
        importedModelList: document.getElementById("imported-model-list"),
        importedModelsPlaceholder: document.getElementById("imported-models-placeholder"),
    };

    map = new maplibregl.Map({
        container: "map",
        style: `https://api.maptiler.com/maps/satellite/style.json?key=5EYOzE3UHralvJsxc3xw`,
        center: [77.0, 10.5],
        zoom: 9,
        pitch: 60,
        bearing: -17.6,
        maxPitch: 85,
        preserveDrawingBuffer: true
    });
    
    map.on('mousemove', (e) => debouncedUpdateElevation(e.lngLat));
    map.on('mouseout', () => { dom.elevationInfo.innerHTML = 'Elevation: N/A'; });
    map.on('load', initialize);
});

async function initialize() {
    map.addControl(new maplibregl.NavigationControl(), "top-right");

    firstSymbolId = map.getStyle().layers.find((l) => l.type === "symbol")?.id || null;
    
    window.updateFirstSymbolId = () => {
        firstSymbolId = map.getStyle().layers.find((l) => l.type === "symbol")?.id || null;
    };

    window.handleDemChange = handleDemChange;
    window.handleVectorToggle = handleVectorToggle;
    window.handleRasterToggle = handleRasterToggle;

    setupUI();
    setupEventListeners();
    initializeModelImporter();

    showLoader("Fetching layer information...");
    try {
        const [demLayers, vectorLayers, rasterLayers] = await Promise.all([
            fetch("/api/elevation_layers").then((res) => res.json()),
            fetch("/api/vector_layers").then((res) => res.json()),
            fetch("/api/raster_layers").then((res) => res.json()),
        ]);

        populateLayerList(dom.demList, demLayers, "radio", "dem-layer", "handleDemChange");
        populateLayerList(dom.vectorList, vectorLayers, "checkbox", "vector-layer", "handleVectorToggle");
        populateLayerList(dom.rasterList, rasterLayers, "checkbox", "raster-layer", "handleRasterToggle");

        const firstDemRadio = dom.demList.querySelector("input[type=radio]");
        if (firstDemRadio) {
            setTimeout(() => firstDemRadio.click(), 100);
        }
    } catch (error) {
        console.error("Initialization failed:", error);
        alert("Could not load layer data. Check console and reload.");
    } finally {
        setTimeout(hideLoader, 500);
    }
}

export function showLoader(text = "Loading...") {
    dom.loaderText.innerText = text;
    dom.loadingOverlay.style.display = "flex";
}

export function hideLoader() {
    dom.loadingOverlay.style.display = "none";
}

function debounce(func, delay) {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), delay);
    };
}

const debouncedUpdateElevation = debounce(async (lngLat) => {
    if (!state.currentDEM) return;
    try {
        const payload = { dem_filename: state.currentDEM.id, lon: lngLat.lng, lat: lngLat.lat };
        const response = await fetch('/api/query_elevation', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        });
        if (!response.ok) return;
        const result = await response.json();
        dom.elevationInfo.innerHTML = (result.elevation !== null) ? `Elevation: ${result.elevation.toFixed(2)} m` : 'Elevation: N/A';
    } catch (error) { /* Fail silently */ }
}, 150);