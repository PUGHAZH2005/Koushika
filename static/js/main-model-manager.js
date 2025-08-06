import { map } from './main.js';

const importedModelList = document.getElementById("imported-model-list");
const importedModelsPlaceholder = document.getElementById("imported-models-placeholder");

/**
 * Adds an item to the UI list for a newly imported model.
 * @param {string} name - The name of the model file.
 * @param {string} layerId - The ID of the map layer for removal.
 * @param {string|null} sourceId - The ID of the map source for removal (for GeoJSON).
 * @param {string} modelId - The unique ID of the model from the server, used for inspection.
 */
export function addImportedModelToList(name, layerId, sourceId, modelId) {
    if (importedModelsPlaceholder) {
        importedModelsPlaceholder.style.display = 'none';
    }

    const item = document.createElement('div');
    item.className = 'imported-model-item';
    item.id = `item-${layerId}`;
    
    item.innerHTML = `
        <span>${name}</span>
        <div class="item-buttons">
            <button class="inspect-btn" title="Inspect Model in New Tab"><i class="fas fa-search-plus"></i> Inspect</button>
            <button class="remove-btn" title="Remove Model from Map"><i class="fas fa-trash"></i></button>
        </div>
    `;

    if (importedModelList) {
        importedModelList.appendChild(item);
    }

    const inspectBtn = item.querySelector('.inspect-btn');
    if (inspectBtn) {
        inspectBtn.onclick = () => {
            window.open(`/inspector/${modelId}`, '_blank');
        };
    }
    
    const removeBtn = item.querySelector('.remove-btn');
    if (removeBtn) {
        removeBtn.onclick = () => {
            if (map.getLayer(layerId)) map.removeLayer(layerId);
            if (sourceId && map.getSource(sourceId)) map.removeSource(sourceId);
            item.remove();
            
            if (importedModelList && importedModelList.querySelectorAll('.imported-model-item').length === 0) {
                 if (importedModelsPlaceholder) importedModelsPlaceholder.style.display = 'block';
            }
        };
    }
}