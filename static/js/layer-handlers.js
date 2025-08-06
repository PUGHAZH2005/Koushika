import { map, state, dom, firstSymbolId, showLoader, hideLoader } from './main.js';
import { updateLegend, updateLabelControl } from './ui.js';

const KEYWORD_COLORS = {
    builtup: "#d73027",      // Red for built-up areas
    building: "#d73027",     // Red for buildings
    water: "#1297f6ff",        // Blue for water
    waterbody: "#1297f6ff",
    river: "#1297f6ff",
    tank:"#1297f6ff",
    tributaries: "#1297f6ff",
    tributary: "#096d86ff",
    tanks:"#4575b4",
    stream: "#4575b4",
    checkdam:"#4C688A",
    Basin:"#9e9ac8",
    impplaces:"#9E097D",
    tea: "#66a61e",          // A different green for tea
    forest: "#1b7837",       // Dark green for forest
    grassland: "#a6d96a",    // Light green for grassland
    plantation: "#1b7837",   // Dark green for plantation
    vegetation: "#1b7837",
    road: "#bababa",         // Light grey for roads
    estate: "#9e9ac8",       // Purple for estate
    boundary: "#fee08b",     // Yellow for boundary
    contour: "#fc8d59",      // Orange for contours
    wood:"#966F33",
    bark:"#966F33",
    stump:"#966F33",
};

const getRandomColor = () => `#${Math.floor(Math.random()*16777215).toString(16).padStart(6, '0')}`;

export function populateLayerList(container, layers, type, name, handlerName) {
    const header = container.querySelector("h4");
    container.innerHTML = "";
    if (header) container.appendChild(header);

    if (!layers || layers.length === 0) {
        container.appendChild(document.createElement("i")).textContent = "No layers found.";
        return;
    }

    layers.forEach((layer) => {
        const itemDiv = document.createElement("div");
        itemDiv.className = "layer-item";
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = type;
        input.name = name;
        input.value = layer.id;
        input.dataset.layerInfo = JSON.stringify(layer);

        const handlerFunction = window[handlerName];
        if (typeof handlerFunction === 'function') {
            input.addEventListener("change", () => handlerFunction(input, false));
        }

        label.append(input, ` ${layer.name}`);
        itemDiv.appendChild(label);
        
        if (name === 'dem-layer') {
            const simBtn = document.createElement('button');
            simBtn.className = 'layer-action-btn';
            simBtn.innerHTML = '<i class="fa-solid fa-water"></i> Simulate';
            simBtn.title = 'Run Flood Simulation';
            simBtn.onclick = (e) => {
                e.stopPropagation();
                window.open(`/flood_simulation/${layer.id}`, '_blank');
            };
            itemDiv.appendChild(simBtn);
        }

        if (type === "checkbox" && name === "raster-layer" && layer.bands > 1) {
            const controlsDiv = document.createElement("div");
            controlsDiv.className = "raster-controls";
            controlsDiv.id = `controls-${layer.id}`;
            controlsDiv.style.display = 'none';
            ['R', 'G', 'B'].forEach((bandName, index) => {
                const wrapper = document.createElement("div");
                wrapper.className = "band-control";
                wrapper.innerHTML = `<label>${bandName}:</label>`;
                const select = document.createElement("select");
                select.dataset.band = bandName.toLowerCase();
                for (let i = 1; i <= layer.bands; i++) {
                    select.add(new Option(`Band ${i}`, i));
                }
                select.selectedIndex = Math.min(index, layer.bands - 1);
                select.addEventListener("change", () => input.checked && handlerFunction(input, true));
                wrapper.appendChild(select);
                controlsDiv.appendChild(wrapper);
            });
            itemDiv.appendChild(controlsDiv);
        }
        container.appendChild(itemDiv);
    });
}

export function handleDemChange(radio) {
    if (!radio.checked) return;
    showLoader("Loading Terrain...");
    try {
        if (state.currentDEM && map.getSource(state.currentDEM.source)) {
            map.setTerrain(null);
            if (map.getLayer("hillshade")) map.removeLayer("hillshade");
            if (map.getSource(state.currentDEM.source)) map.removeSource(state.currentDEM.source);
        }

        const layerInfo = JSON.parse(radio.dataset.layerInfo);
        const demId = layerInfo.id;
        const demSourceId = `dem-source-${demId}`;
        state.currentDEM = { id: demId, name: layerInfo.name, source: demSourceId };

        map.addSource(demSourceId, {
            type: "raster-dem",
            tiles: [`/api/dem_tile/${encodeURIComponent(demId)}/{z}/{x}/{y}.png`],
            tileSize: 256, maxzoom: 15, encoding: "mapbox" 
        });
        map.setTerrain({ source: demSourceId, exaggeration: 1 });
        map.addLayer({
            id: "hillshade", source: demSourceId, type: "hillshade",
            paint: { "hillshade-exaggeration": 0.15, "hillshade-shadow-color": "#000000" }
        }, firstSymbolId);
        flyToBounds("dem", demId);
    } finally {
        setTimeout(hideLoader, 200);
    }
}

export async function handleVectorToggle(checkbox) {
    showLoader("Loading Vector Data...");
    const filename = checkbox.value;
    const layerIdPrefix = `vector-${filename.replace(/[^a-zA-Z0-9]/g, "_")}`;
    try {
        if (checkbox.checked) {
            const response = await fetch(`/api/vector_layer/${encodeURIComponent(filename)}`);
            const geojson = await response.json();
            if (geojson.error) throw new Error(geojson.error);

            geojson.features.forEach((f, i) => (f.properties._uniqueId = `${layerIdPrefix}_${i}`));
            const sourceId = `source-${layerIdPrefix}`;
            map.addSource(sourceId, { type: "geojson", data: geojson });
            const { layers, classification, classField } = generateVectorStyle(layerIdPrefix, sourceId, geojson, filename);
            layers.forEach(layer => map.addLayer(layer, firstSymbolId));
            
            state.activeLayers[layerIdPrefix] = {
                type: "vector", classification, classField, sourceId, filename, geojson,
                layerIds: layers.map(l => l.id),
                displayName: JSON.parse(checkbox.dataset.layerInfo).name,
            };

            // Add the label layer
            addOrUpdateLabelLayer(layerIdPrefix);
            
            flyToBounds("vector", filename);
        } else {
            const layerInfo = state.activeLayers[layerIdPrefix];
            if (layerInfo) {
                if(window.clearFeatureHighlight) window.clearFeatureHighlight();
                layerInfo.layerIds.forEach(id => map.getLayer(id) && map.removeLayer(id));
                
                // --- FIX: Remove the specific label layer ---
                const labelLayerId = `${layerIdPrefix}-labels`;
                if (map.getLayer(labelLayerId)) {
                    map.removeLayer(labelLayerId);
                }

                if (map.getSource(layerInfo.sourceId)) map.removeSource(layerInfo.sourceId);
                delete state.activeLayers[layerIdPrefix];
            }
        }
        updateLegend();
        updateLabelControl();
    } catch (error) {
        console.error("Vector toggle error:", error);
        alert(`Could not load vector layer: ${error.message}`);
        checkbox.checked = false; 
    } finally {
        hideLoader();
    }
}

// --- NEW FUNCTION: Add or update the label layer for a vector source ---
export function addOrUpdateLabelLayer(layerIdPrefix, field = 'Name') {
    const layerInfo = state.activeLayers[layerIdPrefix];
    if (!layerInfo) return;

    const labelLayerId = `${layerIdPrefix}-labels`;

    // Remove existing label layer if it exists, to update it
    if (map.getLayer(labelLayerId)) {
        map.removeLayer(labelLayerId);
    }

    // Don't add a label layer if the field is 'None'
    if (field === 'None') {
        return;
    }

    // Add the new label layer
    map.addLayer({
        id: labelLayerId,
        type: 'symbol',
        source: layerInfo.sourceId,
        minzoom: 12, // Only show labels at higher zoom levels
        layout: {
            'text-field': ['get', field],
            'text-font': ['Open Sans Regular'],
            'text-size': 12,
            'text-allow-overlap': false,
            'text-pitch-alignment': 'viewport',
        },
        paint: {
            'text-color': '#ffffff',
            'text-halo-color': '#000000',
            'text-halo-width': 1,
        }
    });
}


function generateVectorStyle(layerIdPrefix, sourceId, geojson, filename) {
    const classification = {}, layers = [];
    const layerNameLower = filename.toLowerCase();
    const geomType = geojson.features[0]?.geometry.type;
    if (!geomType) return { layers, classification, classField: null };

    const potentialFields = ["Name", "name", "LULC", "Layer", "layer", "TYPE", "type", "CLASS", "class", "CATEGORY", "category", "VILGNAME1"];
    const classField = potentialFields.find(f => geojson.features[0]?.properties?.[f]);
    let colorExpression;

    if (classField) {
        const matchExpression = ["match", ["get", classField]];
        const uniqueValues = [...new Set(geojson.features.map(f => f.properties[classField]).filter(Boolean))];
        uniqueValues.forEach(value => {
            const valueLower = String(value).toLowerCase();
            const colorKey = Object.keys(KEYWORD_COLORS).find(k => valueLower.includes(k));
            const color = colorKey ? KEYWORD_COLORS[colorKey] : getRandomColor();
            classification[String(value)] = { color };
            matchExpression.push(value, color);
        });
        matchExpression.push(getRandomColor());
        colorExpression = matchExpression;
    } else {
        const colorKey = Object.keys(KEYWORD_COLORS).find(k => layerNameLower.includes(k));
        const baseColor = colorKey ? KEYWORD_COLORS[colorKey] : getRandomColor();
        const displayName = dom.vectorList.querySelector(`input[value="${filename}"]`)?.dataset.layerInfo ? JSON.parse(dom.vectorList.querySelector(`input[value="${filename}"]`).dataset.layerInfo).name : filename;
        classification[displayName] = { color: baseColor };
        colorExpression = baseColor;
    }

    if (geomType.includes("Polygon")) {
        const heightField = ["LOD", "height", "Height", "HEIGHT", "relh", "building_h"].find(f => geojson.features[0]?.properties?.[f]);
        const isExtrusion = heightField && (layerNameLower.includes("builtup") || layerNameLower.includes("building"));
        
        if (isExtrusion) {
            layers.push({id: `${layerIdPrefix}-extrusion`, source: sourceId, type: 'fill-extrusion', minzoom: 15, paint: {'fill-extrusion-color': colorExpression, 'fill-extrusion-opacity': 0.85, 'fill-extrusion-base': 0, 'fill-extrusion-height': ["to-number", ["get", heightField], 10]}});
            layers.push({id: `${layerIdPrefix}-fill-lod`, source: sourceId, type: 'fill', maxzoom: 15, paint: {'fill-color': colorExpression, 'fill-opacity': 0.7}});
        } else {
            const isBoundary = layerNameLower.includes("boundary");
            layers.push({id: `${layerIdPrefix}-fill`, source: sourceId, type: "fill", paint: {"fill-color": colorExpression, "fill-opacity": isBoundary ? 0.1 : 0.7 }});
            layers.push({id: `${layerIdPrefix}-line`, source: sourceId, type: "line", paint: {"line-color": colorExpression, "line-width": isBoundary ? 2.5 : 1.5, "line-opacity": 0.9 }});
        }
    } else if (geomType.includes("LineString")) {
        layers.push({id: `${layerIdPrefix}-line`, source: sourceId, type: "line", paint: {"line-color": colorExpression, "line-width": 2.5, "line-opacity": 0.8 }});
    } else if (geomType.includes("Point")) {
        layers.push({id: `${layerIdPrefix}-point`, source: sourceId, type: "circle", paint: {"circle-color": colorExpression, "circle-radius": 5, "circle-stroke-color": "white", "circle-stroke-width": 1, "circle-opacity": 0.9 }});
    }
    return { layers, classification, classField };
}

export function handleRasterToggle(checkbox, isBandChange = false) {
    showLoader();
    const filename = checkbox.value;
    const layerId = `raster-${filename.replace(/[^a-zA-Z0-9]/g, "_")}`;
    const sourceId = `source-${layerId}`;
    const controlsDiv = document.getElementById(`controls-${filename}`);
    try {
        if (checkbox.checked) {
            if (!isBandChange) flyToBounds("raster", filename);
            const info = JSON.parse(checkbox.dataset.layerInfo);
            let tileUrl;
            if (info.bands > 1) {
                if (controlsDiv) controlsDiv.style.display = "block";
                const r = controlsDiv.querySelector('[data-band="r"]').value;
                const g = controlsDiv.querySelector('[data-band="g"]').value;
                const b = controlsDiv.querySelector('[data-band="b"]').value;
                const p_mins = [info.stats[r - 1].min, info.stats[g - 1].min, info.stats[b - 1].min].join(",");
                const p_maxs = [info.stats[r - 1].max, info.stats[g - 1].max, info.stats[b - 1].max].join(",");
                tileUrl = `/api/raster_tile/${encodeURIComponent(filename)}/{z}/{x}/{y}.png?r=${r}&g=${g}&b=${b}&p_mins=${p_mins}&p_maxs=${p_maxs}`;
            } else {
                if (!info.stats?.[0]) throw new Error("Layer info is missing stats");
                const colormap = info.colormap || 'Spectral_r';
                tileUrl = `/api/raster_tile/${encodeURIComponent(filename)}/{z}/{x}/{y}.png?min=${info.stats[0].min}&max=${info.stats[0].max}&colormap=${colormap}`;
            }
            if (map.getSource(sourceId)) {
                if (map.getLayer(layerId)) map.removeLayer(layerId);
                map.removeSource(sourceId);
            }
            state.activeLayers[layerId] = info;
            map.addSource(sourceId, { type: "raster", tiles: [tileUrl], tileSize: 256 });
            map.addLayer({ id: layerId, type: "raster", source: sourceId, paint: { "raster-opacity": 0.75 } }, firstSymbolId);
        } else {
            if (controlsDiv) controlsDiv.style.display = "none";
            if (map.getLayer(layerId)) map.removeLayer(layerId);
            if (map.getSource(sourceId)) map.removeSource(sourceId);
            delete state.activeLayers[layerId];
        }
    } catch (error) {
        console.error("Raster toggle error:", error);
        checkbox.checked = false;
    } finally {
        hideLoader();
    }
}

function flyToBounds(layerType, filename) {
    fetch(`/api/layer_bounds/${layerType}/${encodeURIComponent(filename)}`)
        .then(res => res.json())
        .then(data => {
            if (data.bounds) map.fitBounds(data.bounds, { padding: 100, duration: 1500, essential: true, pitch: map.getPitch(), bearing: map.getBearing() });
            else if (data.error) console.error(`Bounds error for ${filename}:`, data.error);
        }).catch(err => console.error(`Fetch error for bounds of ${filename}:`, err));
}