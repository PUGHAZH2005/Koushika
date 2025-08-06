import { map, state, dom, firstSymbolId, currentPopup, setCurrentPopup, showLoader, hideLoader } from './main.js';
import { toggleMeasureTool, toggleProfileTool, hideProfileChart, handleDerivativeCalculation, handleLandslideAnalysis } from './analysis-tools.js';
import { handleDemChange, handleVectorToggle, handleRasterToggle, addOrUpdateLabelLayer } from './layer-handlers.js';

export function setupUI() {
    const closeAllSlidePanels = () => {
        dom.layersPanel.classList.remove("expanded");
        dom.hazardPanel.classList.remove("expanded");
        dom.viewOptionsPanel.classList.remove("expanded");
        dom.layersTool.classList.remove("active");
        dom.hazardToolBtn.classList.remove("active");
        dom.viewOptionsTool.classList.remove("active");
    };

    dom.layersTool.onclick = () => {
        const isOpen = dom.layersPanel.classList.contains("expanded");
        closeAllSlidePanels();
        if (!isOpen) {
            dom.layersPanel.classList.add("expanded");
            dom.layersTool.classList.add("active");
        }
    };
    dom.closeLayersPanelBtn.onclick = closeAllSlidePanels;

    dom.hazardToolBtn.onclick = () => {
        const isOpen = dom.hazardPanel.classList.contains("expanded");
        closeAllSlidePanels();
        if (!isOpen) {
            dom.hazardPanel.classList.add("expanded");
            dom.hazardToolBtn.classList.add("active");
        }
    };
    dom.closeHazardPanelBtn.onclick = closeAllSlidePanels;
    
    dom.viewOptionsTool.onclick = () => {
        const isOpen = dom.viewOptionsPanel.classList.contains("expanded");
        closeAllSlidePanels();
        if (!isOpen) {
            dom.viewOptionsPanel.classList.add("expanded");
            dom.viewOptionsTool.classList.add("active");
        }
    };
    dom.closeViewOptionsPanelBtn.onclick = closeAllSlidePanels;

    dom.measureTool.onclick = toggleMeasureTool;
    dom.profileTool.onclick = toggleProfileTool;
    dom.closeProfileBtn.onclick = hideProfileChart;
    
    dom.attributesTool.onclick = toggleAttributePanel;
    dom.closeAttributePanelBtn.onclick = toggleAttributePanel;

    dom.downloadPdfBtn.onclick = exportToPDF;

    dom.calculateSlopeBtn.onclick = () => handleDerivativeCalculation("slope");
    dom.calculateAspectBtn.onclick = () => handleDerivativeCalculation("aspect");
    dom.analyzeLandslideBtn.onclick = handleLandslideAnalysis;

    if (dom.attributePanel) {
        document.getElementById('attribute-entries-select').onchange = function() {
            $('.attribute-datatable').DataTable().page.len(parseInt(this.value, 10)).draw();
        };
        document.getElementById('attribute-global-search').onkeyup = function() {
            $.fn.dataTable.tables({ api: true }).search(this.value).draw();
        };
    }
    
    dom.labelLayerSelect.addEventListener('change', () => {
        populateLabelFieldSelect(dom.labelLayerSelect.value);
        addOrUpdateLabelLayer(dom.labelLayerSelect.value, dom.labelFieldSelect.value);
    });

    dom.labelFieldSelect.addEventListener('change', () => {
        addOrUpdateLabelLayer(dom.labelLayerSelect.value, dom.labelFieldSelect.value);
    });

    // --- REVISED: Revert to setStyle for reliability ---
    const API_KEY = "5EYOzE3UHralvJsxc3xw";
    const styles = {
        satellite: `https://api.maptiler.com/maps/satellite/style.json?key=${API_KEY}`,
        topo: `https://api.maptiler.com/maps/topo-v2/style.json?key=${API_KEY}`,
        streets: `https://api.maptiler.com/maps/streets-v2/style.json?key=${API_KEY}`,
    };

    dom.basemapRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            if (e.target.checked) {
                map.setStyle(styles[e.target.value]);
            }
        });
    });
}

// --- NEW: Robust function to re-apply all layers after style change ---
function reapplyAllLayers() {
    showLoader("Applying Layers to New Basemap...");

    // This function will be called on the 'style.load' event.
    // We need a brief timeout to let the new style settle.
    setTimeout(() => {
        window.updateFirstSymbolId(); // Update the global symbol ID reference
        
        // Re-apply DEM and hillshade
        if (state.currentDEM) {
            const demRadio = dom.demList.querySelector(`input[value="${state.currentDEM.id}"]`);
            if (demRadio) {
                // Temporarily uncheck and re-check to trigger the handler correctly
                demRadio.checked = false;
                demRadio.click();
            }
        }

        // Re-apply all other active layers
        Object.keys(state.activeLayers).forEach(layerKey => {
            const layerInfo = state.activeLayers[layerKey];
            let checkbox;
            
            if (layerInfo.type === 'vector') {
                checkbox = dom.vectorList.querySelector(`input[value="${layerInfo.filename}"]`);
            } else if (layerInfo.colormap) { // This identifies analysis layers
                checkbox = dom.analysisLayerList.querySelector(`input[value="${layerInfo.id}"]`);
            } else { // Standard raster
                checkbox = dom.rasterList.querySelector(`input[value="${layerInfo.id}"]`);
            }
            
            if (checkbox) {
                // Temporarily remove from state to avoid conflicts in the handler
                delete state.activeLayers[layerKey]; 
                checkbox.checked = false;
                checkbox.click();
            }
        });
        
        setTimeout(hideLoader, 1500); // Allow time for layers to render
    }, 500);
}

export function updateLabelControl() {
    const activeVectorLayers = Object.entries(state.activeLayers)
        .filter(([_, layer]) => layer.type === 'vector' && layer.geojson?.features.length > 0);
    
    if (activeVectorLayers.length === 0) {
        dom.labelLayerSelect.innerHTML = '<option>No vector layers active</option>';
        dom.labelFieldSelect.innerHTML = '';
        dom.labelLayerSelect.disabled = true;
        dom.labelFieldSelect.disabled = true;
        return;
    }

    dom.labelLayerSelect.disabled = false;
    dom.labelFieldSelect.disabled = false;
    
    const currentSelection = dom.labelLayerSelect.value;
    dom.labelLayerSelect.innerHTML = '';
    
    activeVectorLayers.forEach(([prefix, layer]) => {
        const option = new Option(layer.displayName, prefix);
        dom.labelLayerSelect.add(option);
    });

    if (activeVectorLayers.some(([prefix, _]) => prefix === currentSelection)) {
        dom.labelLayerSelect.value = currentSelection;
    }

    populateLabelFieldSelect(dom.labelLayerSelect.value);
}

// ... the rest of the file (populateLabelFieldSelect, toggleAttributePanel, etc.) is correct ...
// ... until setupEventListeners ...

function populateLabelFieldSelect(layerIdPrefix) {
    const layer = state.activeLayers[layerIdPrefix];
    dom.labelFieldSelect.innerHTML = '';

    const noLabelOption = new Option('None (No Labels)', 'None');
    dom.labelFieldSelect.add(noLabelOption);

    if (layer && layer.geojson?.features.length > 0) {
        const properties = layer.geojson.features[0].properties;
        const potentialFields = ["Name", "name", "VILGNAME1", "TYPE", "type", "Layer"];

        for (const key in properties) {
            if (key !== '_uniqueId') {
                const option = new Option(key, key);
                dom.labelFieldSelect.add(option);
            }
        }
        
        const defaultField = potentialFields.find(field => properties.hasOwnProperty(field));
        if (defaultField) {
            dom.labelFieldSelect.value = defaultField;
        } else {
            dom.labelFieldSelect.value = 'None';
        }
    }
}


function toggleAttributePanel() {
    const isVisible = dom.attributePanel.classList.contains('visible');
    
    if (isVisible) {
        dom.attributePanel.classList.remove('visible');
        dom.attributesTool.classList.remove('active');
        dom.infoPanels.classList.remove('pushed-up');
        dom.legendContainer.classList.remove('pushed-up');

        if (state.filteredLayers) {
            for (const sourceId of state.filteredLayers) {
                const layerInfo = Object.values(state.activeLayers).find(l => l.sourceId === sourceId);
                if (layerInfo && layerInfo.layerIds) {
                    const layerPrefix = layerInfo.layerIds[0].replace(/-[a-z]+(-lod)?$/, '');
                    const labelLayerId = `${layerPrefix}-labels`;

                    layerInfo.layerIds.forEach(mapLayerId => {
                        if (map.getLayer(mapLayerId)) map.setFilter(mapLayerId, null);
                    });
                    if (map.getLayer(labelLayerId)) map.setFilter(labelLayerId, null);
                }
            }
            state.filteredLayers.clear();
        }
    } else {
        populateAttributePanel();
        dom.attributePanel.classList.add('visible');
        dom.attributesTool.classList.add('active');
        dom.infoPanels.classList.add('pushed-up');
        dom.legendContainer.classList.add('pushed-up');
    }
}


export function setupEventListeners() {
    map.on("click", (e) => {
        if (currentPopup) currentPopup.remove();
        if (window.clearFeatureHighlight) window.clearFeatureHighlight();
        if (state.isMeasuring || state.isProfiling) return;
        
        const vectorLayerIds = Object.values(state.activeLayers).flatMap(l => (l.type === 'vector' ? l.layerIds : []));
        if (vectorLayerIds.length > 0) {
            const features = map.queryRenderedFeatures(e.point, { layers: vectorLayerIds });
            if (features.length > 0) {
                const feature = features[0];
                showFeaturePopup(feature, e.lngLat);
                const bbox = turf.bbox(feature.geometry);
                map.fitBounds(bbox, {
                    padding: {top: 100, bottom: 100, left: 450, right: 100},
                    maxZoom: 18,
                    duration: 800
                });
            }
        }
    });

    map.on("moveend", updateLegend);
    
    // --- ADDED: Listener for style changes to re-apply layers ---
    map.on('style.load', reapplyAllLayers);
    
    dom.legendContent.addEventListener('click', (e) => {
        const legendItem = e.target.closest('.legend-item');
        if (!legendItem) return;
        const layerName = legendItem.dataset.layerName;
        const categoryName = legendItem.dataset.categoryName;
        if (layerName && categoryName) zoomToLegendCategory(layerName, categoryName);
    });

    $('#attribute-tables-container').on('click', 'tbody tr', function () {
        const table = $(this).closest('table').DataTable();
        const rowData = table.row(this).data();
        if ($(this).hasClass('selected')) {
            $(this).removeClass('selected');
            if(window.clearFeatureHighlight) window.clearFeatureHighlight();
        } else {
            $('.dataTable').DataTable().rows('.selected').nodes().to$().removeClass('selected');
            $(this).addClass('selected');
            if (rowData?._uniqueId && window.highlightFeatureFromTable) {
                window.highlightFeatureFromTable(rowData._uniqueId);
            }
        }
    });
}
// ... The rest of the file (showFeaturePopup, updateLegend, populateAttributePanel, exportToPDF, etc.) is correct and does not need to be changed.
function showFeaturePopup(feature, lngLat) {
    let content = '<table class="map-popup-table">';
    for (const [key, value] of Object.entries(feature.properties)) {
        if (key !== "_uniqueId") {
            const sanitizedValue = value ? String(value).replace(/</g, "<").replace(/>/g, ">") : "N/A";
            content += `<tr><th>${key}</th><td>${sanitizedValue}</td></tr>`;
        }
    }
    content += "</table>";

    const popup = new maplibregl.Popup({ 
        maxWidth: "350px",
        closeOnClick: true
    }).setLngLat(lngLat).setHTML(content).addTo(map);

    setCurrentPopup(popup);
    window.highlightFeatureOnMap(feature.layer.id, feature.properties._uniqueId);
    highlightRowInTable(feature.properties._uniqueId);
}

export function updateLegend() {
    const activeVectorLayers = Object.values(state.activeLayers).filter(l => l.type === 'vector' && l.layerIds);
    if (activeVectorLayers.length === 0) {
        dom.legendContainer.style.display = 'none';
        return;
    }
    const renderedFeatures = map.queryRenderedFeatures({ layers: activeVectorLayers.flatMap(l => l.layerIds) });
    const visibleCategoriesByLayer = {};
    for (const feature of renderedFeatures) {
        const layerPrefix = feature.properties._uniqueId.split('_')[0];
        const layerKey = Object.keys(state.activeLayers).find(k => k.startsWith(layerPrefix));
        const layer = state.activeLayers[layerKey];
        if (layer && layer.classField) {
            const category = feature.properties[layer.classField];
            if (category) {
                if (!visibleCategoriesByLayer[layer.displayName]) {
                    visibleCategoriesByLayer[layer.displayName] = new Map();
                }
                if (!visibleCategoriesByLayer[layer.displayName].has(category)) {
                     visibleCategoriesByLayer[layer.displayName].set(category, layer.classification[category]);
                }
            }
        }
    }
    let html = "";
    for (const [displayName, categories] of Object.entries(visibleCategoriesByLayer)) {
        if (categories.size > 0) {
            html += `<div class="legend-layer-title">${displayName}</div>`;
            categories.forEach((style, name) => {
                html += `<div class="legend-item" data-layer-name="${displayName}" data-category-name="${name}" title="Zoom to ${name}"><span class="legend-color-box" style="background-color:${style.color}"></span>${name}</div>`;
            });
        }
    }
    if (html) {
        dom.legendContent.innerHTML = html;
        dom.legendContainer.style.display = 'block';
    } else {
        dom.legendContainer.style.display = 'none';
    }
}

function zoomToLegendCategory(layerName, categoryName) {
    const layerEntry = Object.values(state.activeLayers).find(l => l.type === 'vector' && l.displayName === layerName);
    if (!layerEntry || !layerEntry.geojson || !layerEntry.classField) return;
    const features = layerEntry.geojson.features.filter(f => f.properties && f.properties[layerEntry.classField] == categoryName);
    if (features.length > 0) {
        const featureCollection = turf.featureCollection(features);
        const bbox = turf.bbox(featureCollection);
        if (bbox[0] === bbox[2] && bbox[1] === bbox[3]) {
            map.flyTo({ center: [bbox[0], bbox[1]], zoom: 16 });
        } else {
            map.fitBounds(bbox, { padding: 100, duration: 1000 });
        }
    }
}

function populateAttributePanel() {
    const container = dom.attributeTablesContainer;
    container.innerHTML = "";
    let activeVectorLayers = 0;
    state.filteredLayers = new Set();

    Object.values(state.activeLayers).forEach(layer => {
        if (layer.type === 'vector' && layer.geojson?.features.length > 0) {
            activeVectorLayers++;
            const tableCard = document.createElement('div');
            tableCard.innerHTML = `<h3>${layer.displayName}</h3>`;
            const tableId = `datatable-${layer.sourceId.replace(/[^a-zA-Z0-9]/g, "")}`;
            tableCard.innerHTML += `<table id="${tableId}" class="display compact attribute-datatable"></table>`;
            container.appendChild(tableCard);
            const dataForTable = layer.geojson.features.map(f => f.properties);
            const allHeaders = new Set(dataForTable.flatMap(props => Object.keys(props || {})));
            const columns = Array.from(allHeaders).map(h => ({ title: h, data: h, defaultContent: "", visible: h !== "_uniqueId" }));
            const table = new DataTable(`#${tableId}`, {
                columns, data: dataForTable, pageLength: 10, dom: 'tp',
                scrollY: "25vh", scrollCollapse: true,
                createdRow: (row, data) => {
                    $(row).attr('data-uniqueid', data._uniqueId);
                    if (layer.classField && layer.classification) {
                        const category = data[layer.classField];
                        const style = layer.classification[category];
                        if (style && style.color) {
                             $(row).find('td:first-child').css('border-left', `5px solid ${style.color}`);
                        }
                    }
                }
            });
            
            table.on('search.dt', () => {
                const filteredIds = table.rows({ filter: 'applied' }).data().pluck('_uniqueId').toArray();
                state.filteredLayers.add(layer.sourceId);
                const mapFilter = ['in', ['get', '_uniqueId'], ['literal', filteredIds]];

                layer.layerIds.forEach(mapLayerId => {
                    if (map.getLayer(mapLayerId)) map.setFilter(mapLayerId, mapFilter);
                });
                
                const layerPrefix = layer.layerIds[0].replace(/-[a-z]+(-lod)?$/, '');
                const labelLayerId = `${layerPrefix}-labels`;
                if (map.getLayer(labelLayerId)) map.setFilter(labelLayerId, mapFilter);
            });
        }
    });
    if (activeVectorLayers === 0) {
        container.innerHTML = "<p style='padding: 20px;'>No active vector layers with attributes.</p>";
    }
    setTimeout(() => $.fn.dataTable.tables({ visible: true, api: true }).columns.adjust(), 350);
}

async function exportToPDF() {
    showLoader("Preparing PDF...");

    const jsPDF = window.jspdf.jsPDF;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'px', format: 'a4' });
    
    const isFiltered = dom.attributePanel.classList.contains('visible') && state.filteredLayers && state.filteredLayers.size > 0;
    if (isFiltered) {
        let allFilteredFeatures = [];
        for (const sourceId of state.filteredLayers) {
            const layerInfo = Object.values(state.activeLayers).find(l => l.sourceId === sourceId);
            if (layerInfo) {
                const tableAPI = $(`#datatable-${sourceId.replace(/[^a-zA-Z0-9]/g, "")}`).DataTable();
                const filteredIds = new Set(tableAPI.rows({ filter: 'applied' }).data().pluck('_uniqueId').toArray());
                const features = layerInfo.geojson.features.filter(f => filteredIds.has(f.properties._uniqueId));
                allFilteredFeatures.push(...features);
            }
        }
        if (allFilteredFeatures.length > 0) {
            const fc = turf.featureCollection(allFilteredFeatures);
            const bbox = turf.bbox(fc);
            map.fitBounds(bbox, { padding: 80, duration: 0 }); 
        }
    }

    map.once('idle', async () => {
        try {
            const mapCanvas = map.getCanvas();
            const mapImgData = mapCanvas.toDataURL('image/jpeg', 0.8);
            const pageWidth = doc.internal.pageSize.getWidth();
            const pageHeight = doc.internal.pageSize.getHeight();
            doc.addImage(mapImgData, 'JPEG', 0, 0, pageWidth, pageHeight);

            const legendBody = [];
            const activeVectorLayers = Object.values(state.activeLayers).filter(l => l.type === 'vector' && l.classification);

            for (const layer of activeVectorLayers) {
                legendBody.push([{ content: layer.displayName, colSpan: 2, styles: { fontStyle: 'bold', fillColor: '#f0f0f0' } }]);
                for (const categoryName in layer.classification) {
                    const color = layer.classification[categoryName].color;
                    legendBody.push([{ content: '', styles: { fillColor: color } }, categoryName]);
                }
            }

            if (legendBody.length > 0) {
                doc.autoTable({
                    body: legendBody,
                    startY: 15, 
                    margin: { left: pageWidth - 135 }, 
                    tableWidth: 120,
                    theme: 'plain',
                    styles: { fontSize: 8, cellPadding: 2, lineColor: [200, 200, 200], lineWidth: 0.5 },
                    columnStyles: { 0: { cellWidth: 20 } },
                });
            }

            if (activeVectorLayers.length > 0) {
                doc.addPage();
            }

            for (const [index, layer] of activeVectorLayers.entries()) {
                if (index > 0) doc.addPage();
                const data = isFiltered && state.filteredLayers.has(layer.sourceId)
                    ? $(`#datatable-${layer.sourceId.replace(/[^a-zA-Z0-9]/g, "")}`).DataTable().rows({ filter: 'applied' }).data().toArray()
                    : layer.geojson.features.map(f => f.properties);

                if (data.length > 0) {
                    const headers = Object.keys(data[0]).filter(h => h !== '_uniqueId');
                    const body = data.map(row => headers.map(header => row[header] || ''));

                    doc.autoTable({
                        head: [headers], body: body, startY: 40, theme: 'grid',
                        styles: { fontSize: 8, cellPadding: 2 }, headStyles: { fillColor: [41, 128, 185] },
                        didDrawPage: data => doc.text(layer.displayName, data.settings.margin.left, 30),
                    });
                }
            }

            doc.save('map-and-table-export.pdf');

        } catch (error) {
            console.error("Failed to generate PDF:", error);
            alert("An error occurred while creating the PDF. Please check the console.");
        } finally {
            hideLoader();
        }
    });

    map.triggerRepaint();
}


function highlightRowInTable(featureId) {
    $('.dataTable').DataTable().rows('.selected').nodes().to$().removeClass('selected');
    const targetRow = $(`tr[data-uniqueid="${featureId}"]`);
    if (targetRow.length) {
        targetRow.addClass('selected');
        const tableAPI = targetRow.closest('table').DataTable();
        const pageInfo = tableAPI.page.info();
        const rowIndex = tableAPI.row(targetRow).index();
        if (rowIndex < pageInfo.start || rowIndex >= pageInfo.end) {
            tableAPI.page(Math.floor(rowIndex / pageInfo.length)).draw(false);
        }
    }
}

window.highlightFeatureFromTable = function(featureId) {
    const layerKey = Object.keys(state.activeLayers).find(k => featureId.startsWith(k));
    if (!layerKey) return;
    const layer = state.activeLayers[layerKey];
    const feature = layer.geojson.features.find(f => f.properties._uniqueId === featureId);
    if (feature) {
        window.highlightFeatureOnMap(layer.layerIds[0], featureId);
        map.fitBounds(turf.bbox(feature), { padding: 200, maxZoom: 16 });
    }
}

window.highlightFeatureOnMap = function(layerId, featureId) {
    window.clearFeatureHighlight();
    state.highlightedFeature = { layerId, featureId };
    map.addLayer({
        id: "highlight-layer", type: "line", source: map.getLayer(layerId).source,
        paint: { "line-color": "#FFFF00", "line-width": 5, "line-opacity": 0.9 },
        filter: ["==", "_uniqueId", featureId],
    });
}

window.clearFeatureHighlight = function() {
    if (map.getLayer("highlight-layer")) {
        map.removeLayer("highlight-layer");
    }
    state.highlightedFeature = { layerId: null, featureId: null };
}