import type { VoiceSession } from './types';
import { fetchVoiceToken } from '@/sync/apiVoice';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { TokenStorage } from '@/auth/tokenStorage';
import { t } from '@/text';
import { config } from '@/config';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/microphonePermissions';

let voiceSession: VoiceSession | null = null;
let voiceSessionStarted: boolean = false;
let currentSessionId: string | null = null;

export async function startRealtimeSession(sessionId: string, initialContext?: string) {
    if (!voiceSession) {
        console.warn('No voice session registered');
        storage.getState().setRealtimeStatus('error');
        Modal.alert(t('common.error'), t('errors.voiceServiceUnavailable'));
        return;
    }

    // Request microphone permission before starting voice session
    // Critical for iOS/Android - first session will fail without this
    const permissionResult = await requestMicrophonePermission();
    if (!permissionResult.granted) {
        showMicrophonePermissionDeniedAlert(permissionResult.canAskAgain);
        return;
    }

    const settings = storage.getState().settings;
    const experimentsEnabled = settings.experiments;
    const useCustomAgent = settings.elevenLabsUseCustomAgent;
    const customAgentId = settings.elevenLabsAgentId?.trim() || undefined;
    const shouldUseTokenFlow = experimentsEnabled || useCustomAgent;
    const configuredAgentId = __DEV__ ? config.elevenLabsAgentIdDev : config.elevenLabsAgentIdProd;
    
    try {
        // Simple path: no experiments and no custom agent = direct agentId
        if (!shouldUseTokenFlow) {
            if (!configuredAgentId) {
                console.error('Agent ID not configured for non-experimental voice session');
                storage.getState().setRealtimeStatus('error');
                Modal.alert(t('common.error'), t('errors.voiceServiceUnavailable'));
                return;
            }

            await voiceSession.startSession({
                sessionId,
                initialContext,
                agentId: configuredAgentId  // Use agentId directly, no token
            });

            currentSessionId = sessionId;
            voiceSessionStarted = true;
            return;
        }
        
        // Experiments/custom-agent path = authenticated token flow
        const credentials = await TokenStorage.getCredentials();
        if (!credentials) {
            Modal.alert(t('common.error'), t('errors.authenticationFailed'));
            return;
        }
        
        const response = await fetchVoiceToken(credentials, sessionId);
        console.log('[Voice] fetchVoiceToken response:', response);

        if (!response.allowed) {
            console.log('[Voice] Not allowed, presenting paywall...');
            const result = await sync.presentPaywall();
            console.log('[Voice] Paywall result:', result);
            if (result.purchased) {
                await startRealtimeSession(sessionId, initialContext);
            }
            return;
        }

        if (response.token) {
            // Use token from backend
            await voiceSession.startSession({
                sessionId,
                initialContext,
                token: response.token,
                agentId: response.agentId
            });
        } else {
            // No token (e.g. server not deployed yet) - use agentId directly
            const fallbackAgentId = response.agentId || customAgentId || configuredAgentId;
            if (!fallbackAgentId) {
                throw new Error('Voice token missing and no fallback agentId configured');
            }

            await voiceSession.startSession({
                sessionId,
                initialContext,
                agentId: fallbackAgentId
            });
        }

        currentSessionId = sessionId;
        voiceSessionStarted = true;
    } catch (error) {
        console.error('Failed to start realtime session:', error);
        currentSessionId = null;
        voiceSessionStarted = false;
        storage.getState().setRealtimeStatus('error');
        Modal.alert(t('common.error'), t('errors.voiceServiceUnavailable'));
    }
}

export async function stopRealtimeSession() {
    if (!voiceSession) {
        return;
    }
    
    try {
        await voiceSession.endSession();
        currentSessionId = null;
        voiceSessionStarted = false;
    } catch (error) {
        console.error('Failed to stop realtime session:', error);
    }
}

export function registerVoiceSession(session: VoiceSession) {
    if (voiceSession) {
        console.warn('Voice session already registered, replacing with new one');
    }
    voiceSession = session;
}

export function isVoiceSessionStarted(): boolean {
    return voiceSessionStarted;
}

export function getVoiceSession(): VoiceSession | null {
    return voiceSession;
}

export function getCurrentRealtimeSessionId(): string | null {
    return currentSessionId;
}
