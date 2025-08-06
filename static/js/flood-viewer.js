// static/js/flood-viewer.js

const dom = {
    map: document.getElementById('map'),
    toolBtn: document.getElementById('simulation-tool-btn'),
    popup: document.getElementById('simulation-popup'),
    closePopupBtn: document.getElementById('close-popup-btn'),
    demSelect: document.getElementById('dem-select'),
    simulationControls: document.getElementById('simulation-controls'),
    loadRiverBtn: document.getElementById('load-river-btn'),
    addInflowPointBtn: document.getElementById('add-inflow-point-btn'),
    addOutflowPointBtn: document.getElementById('add-outflow-point-btn'),
    clearPointsBtn: document.getElementById('clear-points-btn'),
    gisFloodSimulationBtn: document.getElementById('gis-flood-simulation-btn'),
    animateSimulationBtn: document.getElementById('animate-simulation-btn'),
    projectSimulationBtn: document.getElementById('project-simulation-btn'),
    toggleFlowTrace: document.getElementById('toggle-flow-trace'),
    toggleFlowAccumulation: document.getElementById('toggle-flow-accumulation'),
    toggleChannelFlood: document.getElementById('toggle-channel-flood'),
    downloadChannelFloodBtn: document.getElementById('download-channel-flood-btn'),
    toggle2dFloodZones: document.getElementById('toggle-2d-flood-zones'),
    liveWeatherDisplay: document.getElementById('live-weather-display'),
    weatherStatus: document.getElementById('weather-status'),
    weatherLocation: document.getElementById('weather-location'),
    loadingOverlay: document.getElementById('loading-overlay'),
    loaderText: document.getElementById('loader-text'),
    rainContainer: document.getElementById('rain-container'),
    animationControls: document.getElementById('animation-controls'),
    playPauseBtn: document.getElementById('play-pause-btn'),
    progressContainer: document.getElementById('progress-container'),
    progressBar: document.getElementById('progress-bar'),
    speedSlider: document.getElementById('speed-slider'),
    speedValue: document.getElementById('speed-value'),
};

let map;
let firstSymbolId = null;
const state = {
    selectedDem: null, activeTool: null, points: [], currentRainfall: 0,
    liveWeatherInterval: null, channelFloodCacheId: null,
    animation: {
        lastTimestamp: 0,
        animationFrameId: null,
        duration: 15 * 1000,
        progress: 0,
        speed: 1.0,
        isPlaying: false,
    },
};

const TERRAIN_SOURCE_ID = 'terrain-source-ground';
const GIS_FLOOD_RESULT_SOURCE_ID = 'gis-flood-result-source';
const GIS_FLOOD_RESULT_LAYER_ID = 'gis-flood-result-layer';
const GENERAL_FLOOD_SOURCE_ID = 'general-flood-source'; // Renamed for clarity
const GENERAL_FLOOD_LAYER_ID = 'general-flood-layer';
const FLOW_TRACE_SOURCE_ID = 'flow-trace-dem-source';
const FLOW_TRACE_LAYER_ID = 'flow-trace-layer';
const FLOW_ACCUMULATION_SOURCE_ID = 'flow-accumulation-source';
const FLOW_ACCUMULATION_LAYER_ID = 'flow-accumulation-layer';
const CHANNEL_FLOOD_SOURCE_ID = 'channel-flood-dem-source';
const CHANNEL_FLOOD_LAYER_ID = 'channel-flood-layer';
const WATER_ANIMATION_SOURCE_ID = 'water-animation-source';
const WATER_ANIMATION_LAYER_ID = 'water-animation-layer';
const RIVER_SOURCE_ID = 'river-source';
const RIVER_LAYER_ID = 'river-layer';
const POINTS_SOURCE_ID = 'points-source';
const POINTS_LAYER_ID = 'points-layer';
const PRECALC_FLOOD_SOURCE_ID = 'precalc-flood-zones-source';
const PRECALC_FLOOD_LAYER_ID = 'precalc-flood-zones-layer';

document.addEventListener('DOMContentLoaded', initialize);

async function initialize() {
    showLoader("Initializing Map...");
    map = new maplibregl.Map({ container: 'map', style: `https://api.maptiler.com/maps/satellite/style.json?key=5EYOzE3UHralvJsxc3xw`, zoom: 9, pitch: 0, center: [77.0, 10.5] });
    map.on('load', async () => {
        firstSymbolId = map.getStyle().layers.find(l => l.type === 'symbol')?.id || null;
        await populateDemSelect();
        const preselectedDem = window.PRESELECTED_DEM_ID;
        if (preselectedDem && dom.demSelect.querySelector(`option[value="${preselectedDem}"]`)) {
            dom.demSelect.value = preselectedDem;
            await handleDemSelection();
        }
        hideLoader();
    });
    setupEventListeners();
}

function setupEventListeners() {
    dom.toolBtn.addEventListener('click', () => dom.popup.classList.toggle('visible'));
    dom.closePopupBtn.addEventListener('click', () => dom.popup.classList.remove('visible'));
    dom.demSelect.addEventListener('change', handleDemSelection);
    dom.loadRiverBtn.addEventListener('click', loadRiverNetwork);
    dom.addInflowPointBtn.addEventListener('click', () => setActiveTool('inflow'));
    dom.addOutflowPointBtn.addEventListener('click', () => setActiveTool('outflow'));
    dom.clearPointsBtn.addEventListener('click', clearAllPoints);
    dom.gisFloodSimulationBtn.addEventListener('click', handleGisFloodSimulation);
    dom.animateSimulationBtn.addEventListener('click', handleAnimateFlood);
    dom.projectSimulationBtn.addEventListener('click', handleProjectFlood);
    dom.toggleFlowTrace.addEventListener('change', handleToggleFlowTrace);
    dom.toggleFlowAccumulation.addEventListener('change', handleToggleFlowAccumulation);
    dom.toggleChannelFlood.addEventListener('change', handleToggleChannelFlood);
    dom.downloadChannelFloodBtn.addEventListener('click', handleDownloadChannelFlood);
    dom.toggle2dFloodZones.addEventListener('change', togglePrecalculatedFloodZones);
    map.on('click', onMapClick);
    
    dom.playPauseBtn.addEventListener('click', togglePlayPause);
    dom.speedSlider.addEventListener('input', changeSpeed);
    dom.progressContainer.addEventListener('click', seekAnimation);
}

function updateControlsState() {
    const hasPoints = state.points.length > 0;
    const inflowPoints = state.points.filter(p => p.rate > 0);
    const outflowPoints = state.points.filter(p => p.rate < 0);
    dom.gisFloodSimulationBtn.disabled = !(inflowPoints.length > 0);
    dom.animateSimulationBtn.disabled = !hasPoints;
    dom.projectSimulationBtn.disabled = !hasPoints;
    dom.toggleFlowTrace.disabled = !(inflowPoints.length > 0 && outflowPoints.length > 0);
    dom.toggleFlowAccumulation.disabled = !state.selectedDem;
    dom.toggleChannelFlood.disabled = !(inflowPoints.length > 0);
    dom.downloadChannelFloodBtn.disabled = !state.channelFloodCacheId;
}

// === VISUALIZATION HELPER FUNCTIONS ===

function hideLayer(layerId, sourceId) {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(sourceId)) map.removeSource(sourceId);
}

// Correctly renders a 3D hillshade from a DEM-like raster (e.g., Water Surface Elevation)
function addOrUpdate3DLayer(layerId, sourceId, rasterId, accentColor) {
    hideLayer(layerId, sourceId);
    const tileUrl = `/api/dem_tile/${rasterId}/{z}/{x}/{y}.png`;
    map.addSource(sourceId, { type: 'raster-dem', tiles: [tileUrl], tileSize: 256, encoding: 'mapbox', maxzoom: 15 });
    map.addLayer({
        id: layerId,
        type: 'hillshade',
        source: sourceId,
        paint: {
            'hillshade-illumination-anchor': 'viewport',
            'hillshade-exaggeration': 0.2,
            'hillshade-shadow-color': '#00264d',
            'hillshade-highlight-color': accentColor,
            'hillshade-accent-color': accentColor
        }
    }, RIVER_LAYER_ID || firstSymbolId);
}

// **NEW** Correctly renders a 2D colorized overlay from a data raster (e.g., Flood Depth)
function addOrUpdate2DLayer(layerId, sourceId, rasterId, stats, colormap) {
    hideLayer(layerId, sourceId);
    const tileUrl = `/api/raster_tile/${rasterId}/{z}/{x}/{y}.png?min=${stats.min}&max=${stats.max}&colormap=${colormap}`;
    map.addSource(sourceId, { type: 'raster', tiles: [tileUrl], tileSize: 256 });
    map.addLayer({
        id: layerId,
        type: 'raster',
        source: sourceId,
        paint: { 'raster-opacity': 0.75 }
    }, RIVER_LAYER_ID || firstSymbolId);
}


// === SIMULATION HANDLERS ===

async function handleGisFloodSimulation() {
    hideLayer(GIS_FLOOD_RESULT_LAYER_ID, GIS_FLOOD_RESULT_SOURCE_ID);
    showLoader("Running 2D Flood Simulation...");
    const inflowPoints = state.points.filter(p => p.rate > 0);
    try {
        const response = await fetch('/api/run_gis_flood_simulation', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dem_id: state.selectedDem, inflow_points: inflowPoints }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        // This function correctly shows a 3D WATER SURFACE, so we use the 3D renderer.
        addOrUpdate3DLayer(GIS_FLOOD_RESULT_LAYER_ID, GIS_FLOOD_RESULT_SOURCE_ID, result.cache_filename, '#0b4da1');
        alert("2D Flood Simulation complete. Result layer added to the map.");
    } catch (error) {
        alert(`2D Flood Simulation Failed: ${error.message}`);
    } finally {
        hideLoader();
    }
}

async function handleProjectFlood() {
    hideLayer(GENERAL_FLOOD_LAYER_ID, GENERAL_FLOOD_SOURCE_ID);
    showLoader("Calculating General Flood...");
    try {
        const response = await fetch('/api/projection_data', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dem_id: state.selectedDem, points: state.points })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        
        // This function shows 2D FLOOD DEPTH, so we now use the 2D renderer.
        addOrUpdate2DLayer(GENERAL_FLOOD_LAYER_ID, GENERAL_FLOOD_SOURCE_ID, result.cache_filename, result.stats, 'Blues');
    } catch (error) {
        alert(`Error during General Flood simulation: ${error.message}`);
    } finally {
        hideLoader();
    }
}

// === ANIMATION LOGIC (Now Corrected) ===

async function handleAnimateFlood() {
    if (state.animation.animationFrameId) {
        stopAnimation();
        return;
    }
    showLoader("Calculating Flood Projection...");
    try {
        await fetchLiveWeather();
        const response = await fetch('/api/projection_data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dem_id: state.selectedDem, points: state.points, rainfall_mm_hr: state.currentRainfall }), });
        if (!response.ok) throw new Error((await response.json()).error);
        
        const result = await response.json();
        hideLoader();
        
        // This adds the 2D flood depth layer, initially invisible.
        addAnimatedWaterSurface(result.end_raster_id, result.stats);
        
        dom.animationControls.style.display = 'flex';
        dom.animateSimulationBtn.innerHTML = '<i class="fas fa-stop"></i> Stop Animation';
        dom.animateSimulationBtn.classList.add('active');
        
        togglePlayPause();

    } catch (error) {
        hideLoader();
        stopAnimation();
        alert(`Error setting up projection: ${error.message}`);
    }
}

function stopAnimation() {
    if (state.animation.animationFrameId) {
        cancelAnimationFrame(state.animation.animationFrameId);
    }
    state.animation.animationFrameId = null;
    state.animation.isPlaying = false;
    state.animation.progress = 0;

    dom.animationControls.style.display = 'none';
    dom.animateSimulationBtn.innerHTML = '<i class="fas fa-play"></i> Animate Flood';
    dom.animateSimulationBtn.classList.remove('active');
    dom.playPauseBtn.innerHTML = '<i class="fas fa-play"></i>';
    dom.progressBar.style.width = '0%';
    
    hideLayer(WATER_ANIMATION_LAYER_ID, WATER_ANIMATION_SOURCE_ID);
}

function togglePlayPause() {
    state.animation.isPlaying = !state.animation.isPlaying;
    if (state.animation.isPlaying) {
        dom.playPauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
        if (state.animation.progress >= 1) {
            state.animation.progress = 0;
        }
        state.animation.lastTimestamp = performance.now();
        state.animation.animationFrameId = requestAnimationFrame(animateFrame);
    } else {
        dom.playPauseBtn.innerHTML = '<i class="fas fa-play"></i>';
        cancelAnimationFrame(state.animation.animationFrameId);
        state.animation.animationFrameId = null;
    }
}

function changeSpeed() {
    state.animation.speed = parseFloat(dom.speedSlider.value);
    dom.speedValue.textContent = `${state.animation.speed.toFixed(2)}x`;
}

function seekAnimation(event) {
    const bounds = dom.progressContainer.getBoundingClientRect();
    const clickX = event.clientX - bounds.left;
    const newProgress = clickX / bounds.width;
    state.animation.progress = Math.max(0, Math.min(1, newProgress));
    
    updateAnimationVisuals(state.animation.progress);
}

function animateFrame(timestamp) {
    if (!state.animation.isPlaying) return;

    const delta = (timestamp - state.animation.lastTimestamp) * state.animation.speed;
    state.animation.lastTimestamp = timestamp;

    state.animation.progress += delta / state.animation.duration;

    if (state.animation.progress >= 1) {
        state.animation.progress = 1;
        updateAnimationVisuals(1);
        togglePlayPause();
    } else {
        updateAnimationVisuals(state.animation.progress);
        state.animation.animationFrameId = requestAnimationFrame(animateFrame);
    }
}

function updateAnimationVisuals(progress) {
    if (map.getLayer(WATER_ANIMATION_LAYER_ID)) {
        map.setPaintProperty(WATER_ANIMATION_LAYER_ID, 'raster-opacity', progress * 0.8);
    }
    dom.progressBar.style.width = `${progress * 100}%`;
}

function addAnimatedWaterSurface(rasterId, stats) {
    hideLayer(WATER_ANIMATION_LAYER_ID, WATER_ANIMATION_SOURCE_ID);
    const tileUrl = `/api/raster_tile/${rasterId}/{z}/{x}/{y}.png?min=${stats.min}&max=${stats.max}&colormap=ocean`;
    map.addSource(WATER_ANIMATION_SOURCE_ID, { type: 'raster', tiles: [tileUrl], tileSize: 256, });
    map.addLayer({ 
        id: WATER_ANIMATION_LAYER_ID, 
        type: 'raster', 
        source: WATER_ANIMATION_SOURCE_ID, 
        paint: { "raster-opacity": 0, "raster-fade-duration": 0 } 
    }, RIVER_LAYER_ID || firstSymbolId);
}

// In flood-viewer.js, replace the `handleToggleFlowTrace` function.
// The rest of the file is correct from the previous answer.

async function handleToggleFlowTrace(event) {
    const show = event.target.checked;
    if (!show) {
        if (map.getLayer(FLOW_TRACE_LAYER_ID)) map.setLayoutProperty(FLOW_TRACE_LAYER_ID, 'visibility', 'none');
        return;
    }
    if (map.getLayer(FLOW_TRACE_LAYER_ID)) {
        map.setLayoutProperty(FLOW_TRACE_LAYER_ID, 'visibility', 'visible');
        return;
    }
    showLoader("Tracing Flow Path...");
    try {
        const inflowPoints = state.points.filter(p => p.rate > 0);
        const outflowPoints = state.points.filter(p => p.rate < 0);
        const response = await fetch('/api/trace_flow_path', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                dem_id: state.selectedDem,
                inflow_points: inflowPoints,
                outflow_points: outflowPoints
            }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);

        // === FIX: Use the 2D renderer for a clear, visible path ===
        // We will use a bright 'plasma' colormap to make the trace stand out.
        addOrUpdate2DLayer(FLOW_TRACE_LAYER_ID, FLOW_TRACE_SOURCE_ID, result.cache_filename, result.stats, 'plasma');
        
    } catch (error) {
        alert(`Error during flow trace: ${error.message}`);
        event.target.checked = false;
    } finally {
        hideLoader();
    }
}

async function handleToggleFlowAccumulation(event) {
    const show = event.target.checked;
    if (!show) { if (map.getLayer(FLOW_ACCUMULATION_LAYER_ID)) map.setLayoutProperty(FLOW_ACCUMULATION_LAYER_ID, 'visibility', 'none'); return; }
    if (map.getLayer(FLOW_ACCUMULATION_LAYER_ID)) { map.setLayoutProperty(FLOW_ACCUMULATION_LAYER_ID, 'visibility', 'visible'); return; }
    showLoader("Calculating Flow Accumulation...");
    try {
        const response = await fetch('/api/calculate_flow_accumulation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dem_id: state.selectedDem }), });
        const result = await response.json(); if (!response.ok) throw new Error(result.error);
        const { cache_filename, stats } = result;
        addOrUpdate2DLayer(FLOW_ACCUMULATION_LAYER_ID, FLOW_ACCUMULATION_SOURCE_ID, cache_filename, stats, 'viridis');
    } catch (error) { alert(`Error during Flow Accumulation: ${error.message}`); event.target.checked = false; } finally { hideLoader(); }
}

async function handleToggleChannelFlood(event) {
    const show = event.target.checked;
    if (!show) { if (map.getLayer(CHANNEL_FLOOD_LAYER_ID)) map.setLayoutProperty(CHANNEL_FLOOD_LAYER_ID, 'visibility', 'none'); dom.downloadChannelFloodBtn.disabled = true; return; }
    if (map.getLayer(CHANNEL_FLOOD_LAYER_ID)) { map.setLayoutProperty(CHANNEL_FLOOD_LAYER_ID, 'visibility', 'visible'); dom.downloadChannelFloodBtn.disabled = false; return; }
    showLoader("Simulating Channelized Flood...");
    try {
        const inflowPoints = state.points.filter(p => p.rate > 0);
        const response = await fetch('/api/channelized_flood_simulation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dem_id: state.selectedDem, inflow_points: inflowPoints }), });
        const result = await response.json(); if (!response.ok) throw new Error(result.error);
        state.channelFloodCacheId = result.cache_filename;
        updateControlsState();
        addOrUpdate3DLayer(CHANNEL_FLOOD_LAYER_ID, CHANNEL_FLOOD_SOURCE_ID, result.cache_filename, '#08306b');
    } catch (error) { alert(`Error during Channelized Flood simulation: ${error.message}`); event.target.checked = false; state.channelFloodCacheId = null; updateControlsState(); } finally { hideLoader(); }
}

async function handleDownloadChannelFlood() {
    if (!state.channelFloodCacheId) { alert("Please generate a 'Channelized Flood' layer first."); return; }
    showLoader("Exporting Shapefile...");
    try {
        const response = await fetch('/api/export_channel_flood', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cache_filename: state.channelFloodCacheId }), });
        if (!response.ok) { const errorResult = await response.json(); throw new Error(errorResult.error || "Server failed to generate the file."); }
        const blob = await response.blob(); const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a'); a.style.display = 'none'; a.href = url;
        a.download = 'channel_flood_centerline.zip'; document.body.appendChild(a);
        a.click(); window.URL.revokeObjectURL(url); a.remove();
    } catch (error) { alert(`Error exporting file: ${error.message}`); } finally { hideLoader(); }
}

async function handleDemSelection() {
    stopAnimation(); stopLiveWeatherUpdates();
    const selectedOption = dom.demSelect.options[dom.demSelect.selectedIndex];
    if (!selectedOption.value) { dom.simulationControls.style.display = 'none'; cleanupMapLayers(); return; }
    showLoader("Configuring 3D Environment...");
    state.selectedDem = selectedOption.value;
    cleanupMapLayers();
    map.addSource(TERRAIN_SOURCE_ID, { type: 'raster-dem', tiles: [`/api/dem_tile/${state.selectedDem}/{z}/{x}/{y}.png`], tileSize: 256, encoding: 'mapbox', maxzoom: 15 });
    map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: 1.5 });
    map.addLayer({ id: 'hillshade', source: TERRAIN_SOURCE_ID, type: 'hillshade', paint: { 'hillshade-exaggeration': 0.3 } }, firstSymbolId);
    dom.loadRiverBtn.disabled = false;
    dom.simulationControls.style.display = 'block';
    updateControlsState();
    try {
        const response = await fetch(`/api/layer_bounds_polygon/${state.selectedDem}`);
        const boundsGeoJSON = await response.json(); if (boundsGeoJSON.error) throw new Error(boundsGeoJSON.error);
        map.fitBounds(turf.bbox(boundsGeoJSON), { padding: 40, duration: 1500, pitch: 60 });
        startLiveWeatherUpdates();
    } catch (e) { console.error("Could not fetch bounds:", e); } finally { hideLoader(); }
}

function onMapClick(e) {
    if (!state.activeTool) return;
    const rateType = state.activeTool;
    const promptMessage = rateType === 'inflow' ? "Enter inflow rate (m³/s):" : "Enter outflow rate (m³/s) (as a positive number):";
    const rateStr = prompt(promptMessage, "150");
    if (rateStr === null) { setActiveTool(null); return; }
    let rate = parseFloat(rateStr);
    if (isNaN(rate) || rate < 0) { alert("Invalid rate. Please enter a positive number."); return; }
    if (rateType === 'outflow') rate = -rate;
    state.points.push({ lon: e.lngLat.lng, lat: e.lngLat.lat, rate: rate });
    updatePointsLayer(); updateControlsState(); setActiveTool(null);
}

function clearAllPoints() {
    cleanupMapLayers(false);
    updateControlsState();
}

function cleanupMapLayers(fullCleanup = true) {
    stopAnimation();
    const layers = [RIVER_LAYER_ID, POINTS_LAYER_ID, WATER_ANIMATION_LAYER_ID, GENERAL_FLOOD_LAYER_ID, FLOW_TRACE_LAYER_ID, FLOW_ACCUMULATION_LAYER_ID, CHANNEL_FLOOD_LAYER_ID, PRECALC_FLOOD_LAYER_ID, GIS_FLOOD_RESULT_LAYER_ID];
    const sources = [RIVER_SOURCE_ID, POINTS_SOURCE_ID, WATER_ANIMATION_SOURCE_ID, GENERAL_FLOOD_SOURCE_ID, FLOW_TRACE_SOURCE_ID, FLOW_ACCUMULATION_SOURCE_ID, CHANNEL_FLOOD_SOURCE_ID, PRECALC_FLOOD_SOURCE_ID, GIS_FLOOD_RESULT_SOURCE_ID];
    layers.forEach(id => { if (map.getLayer(id)) map.removeLayer(id); });
    sources.forEach(id => { if (map.getSource(id)) map.removeSource(id); });
    state.points = []; state.channelFloodCacheId = null;
    if (fullCleanup) {
        if (map.getLayer('hillshade')) map.removeLayer('hillshade');
        if (map.getSource(TERRAIN_SOURCE_ID)) map.removeSource(TERRAIN_SOURCE_ID);
        if (map.getTerrain()) map.setTerrain(null);
    }
    [dom.toggle2dFloodZones, dom.toggleFlowAccumulation, dom.toggleChannelFlood, dom.toggleFlowTrace].forEach(cb => { if(cb) cb.checked = false; });
    updateControlsState();
}

async function populateDemSelect() { try { const dems = await fetch('/api/elevation_layers').then(res => res.json()); dom.demSelect.innerHTML = `<option value="">-- Select a DEM to Begin --</option>`; dems.forEach(dem => { dom.demSelect.appendChild(new Option(dem.name, dem.id)); }); } catch (error) { console.error("Failed to populate DEMs:", error); } }

async function loadRiverNetwork() { showLoader("Loading River Network..."); dom.loadRiverBtn.disabled = true; if (map.getLayer(RIVER_LAYER_ID)) map.removeLayer(RIVER_LAYER_ID); if (map.getSource(RIVER_SOURCE_ID)) map.removeSource(RIVER_SOURCE_ID); try { const response = await fetch('/api/stream_layer'); if (!response.ok) throw new Error((await response.json()).error); const riverGeoJSON = await response.json(); map.addSource(RIVER_SOURCE_ID, { type: 'geojson', data: riverGeoJSON }); map.addLayer({ id: RIVER_LAYER_ID, type: 'line', source: RIVER_SOURCE_ID, paint: { 'line-color': '#aed6f1', 'line-width': 1.5, 'line-opacity': 0.7 } }, firstSymbolId); } catch (error) { alert(`Error loading river network: ${error.message}`); dom.loadRiverBtn.disabled = false; } finally { hideLoader(); } }

function setActiveTool(tool) { state.activeTool = state.activeTool === tool ? null : tool; dom.addInflowPointBtn.classList.toggle('active', state.activeTool === 'inflow'); dom.addOutflowPointBtn.classList.toggle('active', state.activeTool === 'outflow'); map.getCanvas().style.cursor = state.activeTool ? 'crosshair' : ''; }

function updatePointsLayer() { const source = map.getSource(POINTS_SOURCE_ID); const features = state.points.map(p => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { rate: p.rate } })); const geojson = { type: 'FeatureCollection', features }; if (source) { source.setData(geojson); } else { map.addSource(POINTS_SOURCE_ID, { type: 'geojson', data: geojson }); map.addLayer({ id: POINTS_LAYER_ID, type: 'circle', source: POINTS_SOURCE_ID, paint: { 'circle-radius': 8, 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff', 'circle-color': ['case', ['>=', ['get', 'rate'], 0], '#2ECC71', '#E74C3C'] } }); } }

function startLiveWeatherUpdates() { stopLiveWeatherUpdates(); if (dom.liveWeatherDisplay) dom.liveWeatherDisplay.style.display = 'block'; fetchLiveWeather(); state.liveWeatherInterval = setInterval(fetchLiveWeather, 60000); }

function stopLiveWeatherUpdates() { if (state.liveWeatherInterval) clearInterval(state.liveWeatherInterval); state.liveWeatherInterval = null; if (dom.liveWeatherDisplay) dom.liveWeatherDisplay.style.display = 'none'; createRainEffect(0); }

async function fetchLiveWeather() { if (!map) return; const center = map.getCenter(); if (dom.weatherLocation) dom.weatherLocation.textContent = `Lat: ${center.lat.toFixed(2)}, Lon: ${center.lng.toFixed(2)}`; if (dom.weatherStatus) dom.weatherStatus.textContent = 'Updating...'; try { const response = await fetch(`/api/get_live_rainfall?lat=${center.lat}&lon=${center.lng}`); const data = await response.json(); if (!data.success) throw new Error(data.error || 'Failed to fetch'); state.currentRainfall = data.current_precipitation_mmhr; updateWeatherDisplay(state.currentRainfall); createRainEffect(state.currentRainfall); } catch (error) { console.error("Live weather error:", error); if (dom.weatherStatus) dom.weatherStatus.textContent = 'Weather Unavailable'; } }

function classifyRainfall(mm) { if (mm <= 0.01) return "No Rain"; if (mm < 2.5) return `Light Rain (${mm.toFixed(1)} mm/hr)`; if (mm < 7.6) return `Moderate Rain (${mm.toFixed(1)} mm/hr)`; if (mm < 50) return `Heavy Rain (${mm.toFixed(1)} mm/hr)`; return `Violent Rain (${mm.toFixed(1)} mm/hr)`; }

function updateWeatherDisplay(rainfall) { if (dom.weatherStatus) dom.weatherStatus.textContent = classifyRainfall(rainfall); const icon = dom.liveWeatherDisplay.querySelector('i'); if (icon) { if (rainfall < 0.1) icon.className = "fas fa-sun"; else if (rainfall < 7.6) icon.className = "fas fa-cloud-rain"; else icon.className = "fas fa-cloud-showers-heavy"; } }

function createRainEffect(intensity) { if (!dom.rainContainer) return; const visualIntensity = Math.min(intensity, 25) * 6; dom.rainContainer.innerHTML = ''; for (let i = 0; i < visualIntensity; i++) { const drop = document.createElement('div'); drop.className = 'raindrop'; drop.style.left = `${Math.random() * 100}%`; drop.style.animationDuration = `${0.5 + Math.random() * 0.5}s`; drop.style.animationDelay = `${Math.random() * 2}s`; dom.rainContainer.appendChild(drop); } }

async function togglePrecalculatedFloodZones(event) {
    const isVisible = event.target.checked;
    if (map.getLayer(PRECALC_FLOOD_LAYER_ID)) { map.setLayoutProperty(PRECALC_FLOOD_LAYER_ID, 'visibility', isVisible ? 'visible' : 'none'); return; }
    if (isVisible) {
        showLoader("Loading Flood Hazard Zones...");
        try {
            const floodZonesGeoJSON = await fetch('/api/precalculated_flood_zones').then(res => res.json());
            if (map.getSource(PRECALC_FLOOD_SOURCE_ID)) map.getSource(PRECALC_FLOOD_SOURCE_ID).setData(floodZonesGeoJSON);
            else map.addSource(PRECALC_FLOOD_SOURCE_ID, { type: 'geojson', data: floodZonesGeoJSON });
            map.addLayer({
                id: PRECALC_FLOOD_LAYER_ID, type: 'fill', source: PRECALC_FLOOD_SOURCE_ID,
                layout: { 'visibility': 'visible' },
                paint: { 'fill-color': ['match', ['get', 'risk_level'], 'High', '#d73027', 'Medium', '#fee08b', 'Low', '#4575b4', '#ccc'], 'fill-opacity': 0.55, 'fill-outline-color': '#000' }
            });
            map.on('click', PRECALC_FLOOD_LAYER_ID, (e) => {
                const props = e.features[0].properties;
                new maplibregl.Popup().setLngLat(e.lngLat).setHTML(`<div style="font-family: sans-serif; max-width: 250px;"><h4 style="margin: 0 0 5px; color: #333;">${props.name}</h4><strong style="color: #555;">Risk:</strong> ${props.risk_level}<br><strong style="color: #555;">Scenario:</strong> ${props.scenario}</div>`).addTo(map);
            });
            map.on('mouseenter', PRECALC_FLOOD_LAYER_ID, () => { map.getCanvas().style.cursor = 'pointer'; });
            map.on('mouseleave', PRECALC_FLOOD_LAYER_ID, () => { map.getCanvas().style.cursor = ''; });
        } catch (error) { console.error("Failed to load pre-calculated flood zones:", error); alert("Could not load the flood hazard zones."); event.target.checked = false; } finally { hideLoader(); }
    }
}

function showLoader(text) { if (dom.loaderText) dom.loaderText.textContent = text; if (dom.loadingOverlay) dom.loadingOverlay.style.display = 'flex'; }
function hideLoader() { if (dom.loadingOverlay) dom.loadingOverlay.style.display = 'none'; }