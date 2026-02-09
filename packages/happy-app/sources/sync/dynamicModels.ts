import { machineListModels, sessionListModels, SessionModelItem } from './ops';

const CACHE_TTL_MS = 5 * 60 * 1000;

export interface DynamicModelOption {
    id: string;
    label: string;
    description?: string;
}

interface ModelCacheEntry {
    expiresAt: number;
    models: DynamicModelOption[];
}

const cacheByKey = new Map<string, ModelCacheEntry>();

function normalizeModelLabel(item: SessionModelItem): string {
    if (item.displayName?.trim()) {
        return item.displayName;
    }
    if (item.model?.trim()) {
        return item.model;
    }
    return item.id;
}

function toDynamicOptions(models: SessionModelItem[]): DynamicModelOption[] {
    const dedup = new Map<string, DynamicModelOption>();
    for (const model of models) {
        const id = (model.model || model.id)?.trim();
        if (!id) continue;
        if (dedup.has(id)) continue;

        dedup.set(id, {
            id,
            label: normalizeModelLabel(model),
            description: model.description || undefined
        });
    }

    return Array.from(dedup.values());
}

function getCached(cacheKey: string): DynamicModelOption[] | null {
    const entry = cacheByKey.get(cacheKey);
    if (!entry) {
        return null;
    }
    if (entry.expiresAt <= Date.now()) {
        cacheByKey.delete(cacheKey);
        return null;
    }
    return entry.models;
}

function setCache(cacheKey: string, models: DynamicModelOption[]) {
    cacheByKey.set(cacheKey, {
        models,
        expiresAt: Date.now() + CACHE_TTL_MS
    });
}

export async function fetchCodexModelsForSession(sessionId: string): Promise<DynamicModelOption[]> {
    const cacheKey = `session:${sessionId}`;
    const cached = getCached(cacheKey);
    if (cached) {
        return cached;
    }

    const response = await sessionListModels(sessionId, { provider: 'codex', limit: 200 });
    const models = response.success && response.data
        ? toDynamicOptions(response.data)
        : [];

    setCache(cacheKey, models);
    return models;
}

export async function fetchCodexModelsForMachine(machineId: string): Promise<DynamicModelOption[]> {
    const cacheKey = `machine:${machineId}`;
    const cached = getCached(cacheKey);
    if (cached) {
        return cached;
    }

    const response = await machineListModels(machineId, { provider: 'codex', limit: 200 });
    const models = response.success && response.data
        ? toDynamicOptions(response.data)
        : [];

    setCache(cacheKey, models);
    return models;
}
