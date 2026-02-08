import type { VoiceSession } from './types';
import { fetchVoiceToken } from '@/sync/apiVoice';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { TokenStorage } from '@/auth/tokenStorage';
import { t } from '@/text';
import { config } from '@/config';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/microphonePermissions';
import { tracking } from '@/track';

let voiceSession: VoiceSession | null = null;
let voiceSessionStarted: boolean = false;
let currentSessionId: string | null = null;

export async function startRealtimeSession(sessionId: string, initialContext?: string) {
    tracking?.capture('voice_start_step', {
        step: 'start_called',
        sessionId,
    });

    if (!voiceSession) {
        console.warn('No voice session registered');
        tracking?.capture('voice_start_step', {
            step: 'voice_session_missing',
            sessionId,
        });
        storage.getState().setRealtimeStatus('error');
        Modal.alert(t('common.error'), t('errors.voiceServiceUnavailable'));
        return;
    }

    // Request microphone permission before starting voice session
    // Critical for iOS/Android - first session will fail without this
    const permissionResult = await requestMicrophonePermission();
    tracking?.capture('voice_start_step', {
        step: permissionResult.granted ? 'permission_granted' : 'permission_denied',
        sessionId,
        canAskAgain: permissionResult.canAskAgain ?? null,
    });
    if (!permissionResult.granted) {
        showMicrophonePermissionDeniedAlert(permissionResult.canAskAgain);
        return;
    }

    const settings = storage.getState().settings;
    const experimentsEnabled = settings.experiments;
    const useCustomAgent = settings.elevenLabsUseCustomAgent;
    const customAgentId = settings.elevenLabsAgentId?.trim() || undefined;
    const customApiKey = settings.elevenLabsApiKey?.trim() || undefined;
    const hasCustomAgentCredentials = !!customAgentId && !!customApiKey;
    const shouldUseTokenFlow = experimentsEnabled || hasCustomAgentCredentials;
    const configuredAgentId = __DEV__ ? config.elevenLabsAgentIdDev : config.elevenLabsAgentIdProd;

    tracking?.capture('voice_start_step', {
        step: 'config_resolved',
        sessionId,
        experimentsEnabled,
        useCustomAgent,
        hasCustomAgentCredentials,
        hasConfiguredAgentId: !!configuredAgentId,
        shouldUseTokenFlow,
    });

    try {
        if (useCustomAgent && !hasCustomAgentCredentials) {
            tracking?.capture('voice_start_step', {
                step: 'custom_credentials_missing',
                sessionId,
            });
            storage.getState().setRealtimeStatus('error');
            Modal.alert(t('common.error'), t('settingsVoice.credentialsRequired'));
            return;
        }

        // Simple path: no experiments and no custom agent = direct agentId
        if (!shouldUseTokenFlow) {
            if (!configuredAgentId) {
                console.error('Agent ID not configured for non-experimental voice session');
                tracking?.capture('voice_start_step', {
                    step: 'configured_agent_missing',
                    sessionId,
                });
                storage.getState().setRealtimeStatus('error');
                Modal.alert(t('common.error'), t('errors.voiceServiceUnavailable'));
                return;
            }

            tracking?.capture('voice_start_step', {
                step: 'direct_agent_start_attempt',
                sessionId,
            });

            await voiceSession.startSession({
                sessionId,
                initialContext,
                agentId: configuredAgentId  // Use agentId directly, no token
            });

            tracking?.capture('voice_start_step', {
                step: 'direct_agent_start_success',
                sessionId,
            });

            currentSessionId = sessionId;
            voiceSessionStarted = true;
            return;
        }
        
        // Experiments/custom-agent path = authenticated token flow
        const credentials = await TokenStorage.getCredentials();
        if (!credentials) {
            tracking?.capture('voice_start_step', {
                step: 'auth_credentials_missing',
                sessionId,
            });
            Modal.alert(t('common.error'), t('errors.authenticationFailed'));
            return;
        }

        tracking?.capture('voice_start_step', {
            step: 'token_request_attempt',
            sessionId,
        });

        const response = await fetchVoiceToken(credentials, sessionId);
        console.log('[Voice] fetchVoiceToken response:', response);

        tracking?.capture('voice_start_step', {
            step: 'token_response',
            sessionId,
            allowed: !!response.allowed,
            hasToken: !!response.token,
            hasResponseAgentId: !!response.agentId,
            hasError: !!response.error,
        });

        if (!response.allowed) {
            // If backend returned a concrete error (e.g., invalid custom credentials),
            // surface it instead of silently trying paywall.
            if (response.error) {
                console.warn('[Voice] Not allowed with backend error:', response.error);
                tracking?.capture('voice_start_step', {
                    step: 'token_not_allowed_with_error',
                    sessionId,
                });
                storage.getState().setRealtimeStatus('error');
                Modal.alert(t('common.error'), response.error);
                return;
            }

            console.log('[Voice] Not allowed, presenting paywall...');
            tracking?.capture('voice_start_step', {
                step: 'paywall_present_attempt',
                sessionId,
            });

            const result = await sync.presentPaywall();
            console.log('[Voice] Paywall result:', result);

            tracking?.capture('voice_start_step', {
                step: 'paywall_result',
                sessionId,
                success: !!result.success,
                purchased: !!result.purchased,
                hasError: !!result.error,
            });

            if (result.purchased) {
                await startRealtimeSession(sessionId, initialContext);
                return;
            }

            if (!result.success) {
                storage.getState().setRealtimeStatus('error');
                Modal.alert(t('common.error'), result.error || t('errors.voiceServiceUnavailable'));
            }
            return;
        }

        if (response.token) {
            // Use token from backend
            tracking?.capture('voice_start_step', {
                step: 'token_session_start_attempt',
                sessionId,
            });

            await voiceSession.startSession({
                sessionId,
                initialContext,
                token: response.token,
                agentId: response.agentId
            });

            tracking?.capture('voice_start_step', {
                step: 'token_session_start_success',
                sessionId,
            });
        } else {
            // No token (e.g. server not deployed yet) - use agentId directly
            const fallbackAgentId = response.agentId || customAgentId || configuredAgentId;
            if (!fallbackAgentId) {
                tracking?.capture('voice_start_step', {
                    step: 'fallback_agent_missing',
                    sessionId,
                });
                throw new Error('Voice token missing and no fallback agentId configured');
            }

            tracking?.capture('voice_start_step', {
                step: 'fallback_agent_start_attempt',
                sessionId,
                source: response.agentId ? 'response' : customAgentId ? 'custom' : 'configured',
            });

            await voiceSession.startSession({
                sessionId,
                initialContext,
                agentId: fallbackAgentId
            });

            tracking?.capture('voice_start_step', {
                step: 'fallback_agent_start_success',
                sessionId,
            });
        }

        currentSessionId = sessionId;
        voiceSessionStarted = true;

        tracking?.capture('voice_start_step', {
            step: 'start_completed',
            sessionId,
        });
    } catch (error) {
        console.error('Failed to start realtime session:', error);
        currentSessionId = null;
        voiceSessionStarted = false;
        storage.getState().setRealtimeStatus('error');
        tracking?.capture('voice_start_step', {
            step: 'start_failed',
            sessionId,
            error: error instanceof Error ? error.message : 'Unknown error',
        });
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
