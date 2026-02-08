import React, { useEffect, useRef } from 'react';
import { useConversation } from '@elevenlabs/react';
import { registerVoiceSession } from './RealtimeSession';
import { storage, useRealtimeMicMuted } from '@/sync/storage';
import { realtimeClientTools } from './realtimeClientTools';
import { getElevenLabsCodeFromPreference } from '@/constants/Languages';
import type { VoiceSession, VoiceSessionConfig } from './types';

const DEBUG = !!process.env.PUBLIC_EXPO_DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING;

// Static reference to the conversation hook instance
let conversationInstance: ReturnType<typeof useConversation> | null = null;

// Global voice session implementation
class RealtimeVoiceSessionImpl implements VoiceSession {

    async startSession(config: VoiceSessionConfig): Promise<void> {
        if (DEBUG) console.log('[RealtimeVoiceSessionImpl] conversationInstance:', conversationInstance);
        if (!conversationInstance) {
            console.warn('Realtime voice session not initialized - conversationInstance is null');
            throw new Error('Realtime voice session not initialized');
        }

        try {
            storage.getState().setRealtimeStatus('connecting');

            // Request microphone permission first
            try {
                await navigator.mediaDevices.getUserMedia({ audio: true });
            } catch (error) {
                console.error('Failed to get microphone permission:', error);
                storage.getState().setRealtimeStatus('error');
                throw error;
            }

            // Get user's preferred language for voice assistant
            const userLanguagePreference = storage.getState().settings.voiceAssistantLanguage;
            const elevenLabsLanguage = getElevenLabsCodeFromPreference(userLanguagePreference);

            if (!config.token && !config.agentId) {
                throw new Error('Neither token nor agentId provided');
            }

            const sessionConfig: any = {
                connectionType: 'webrtc',
                dynamicVariables: {
                    sessionId: config.sessionId,
                    initialConversationContext: config.initialContext || ''
                },
                overrides: {
                    agent: {
                        language: elevenLabsLanguage
                    }
                },
                ...(config.token ? { conversationToken: config.token } : { agentId: config.agentId })
            };

            const conversationId = await conversationInstance.startSession(sessionConfig);
            if (DEBUG) console.log('Started conversation with ID:', conversationId);
        } catch (error) {
            console.error('Failed to start realtime session:', error);
            storage.getState().setRealtimeStatus('error');
            throw error;
        }
    }

    async endSession(): Promise<void> {
        if (!conversationInstance) {
            return;
        }

        try {
            await conversationInstance.endSession();
            storage.getState().setRealtimeStatus('disconnected');
        } catch (error) {
            console.error('Failed to end realtime session:', error);
        }
    }

    sendTextMessage(message: string): void {
        if (!conversationInstance) {
            console.warn('Realtime voice session not initialized');
            return;
        }

        conversationInstance.sendUserMessage(message);
    }

    sendContextualUpdate(update: string): void {
        if (!conversationInstance) {
            console.warn('Realtime voice session not initialized');
            return;
        }

        conversationInstance.sendContextualUpdate(update);
    }
}

export const RealtimeVoiceSession: React.FC = () => {
    const micMuted = useRealtimeMicMuted();

    const conversation = useConversation({
        clientTools: realtimeClientTools,
        micMuted,
        onConnect: () => {
            if (DEBUG) console.log('Realtime session connected');
            storage.getState().setRealtimeStatus('connected');
            storage.getState().setRealtimeMode('idle');
        },
        onDisconnect: () => {
            if (DEBUG) console.log('Realtime session disconnected');
            storage.getState().setRealtimeStatus('disconnected');
            storage.getState().setRealtimeMode('idle', true); // immediate mode change
            storage.getState().clearRealtimeModeDebounce();
        },
        onMessage: (data) => {
            if (DEBUG) console.log('Realtime message:', data);
        },
        onError: (error) => {
            // Log but don't block app - voice features will be unavailable
            // This prevents initialization errors from showing "Terminals error" on startup
            if (DEBUG) console.warn('Realtime voice not available:', error);
            // Don't set error status during initialization - just set disconnected
            // This allows the app to continue working without voice features
            storage.getState().setRealtimeStatus('disconnected');
            storage.getState().setRealtimeMode('idle', true); // immediate mode change
        },
        onStatusChange: (data) => {
            if (DEBUG) console.log('Realtime status change:', data);
        },
        onModeChange: (data) => {
            if (DEBUG) console.log('Realtime mode change:', data);

            // Only animate when speaking
            const mode = data.mode as string;
            const isSpeaking = mode === 'speaking';

            // Use centralized debounce logic from storage
            storage.getState().setRealtimeMode(isSpeaking ? 'speaking' : 'idle');
        },
        onDebug: (message) => {
            if (DEBUG) console.debug('Realtime debug:', message);
        }
    });

    const hasRegistered = useRef(false);

    useEffect(() => {
        // Store the conversation instance globally
        if (DEBUG) console.log('[RealtimeVoiceSession] Setting conversationInstance:', conversation);
        conversationInstance = conversation;

        // Register the voice session once
        if (!hasRegistered.current) {
            try {
                if (DEBUG) console.log('[RealtimeVoiceSession] Registering voice session');
                registerVoiceSession(new RealtimeVoiceSessionImpl());
                hasRegistered.current = true;
                if (DEBUG) console.log('[RealtimeVoiceSession] Voice session registered successfully');
            } catch (error) {
                console.error('Failed to register voice session:', error);
            }
        }

        return () => {
            // Clean up on unmount
            conversationInstance = null;
        };
    }, [conversation]);

    // This component doesn't render anything visible
    return null;
};
