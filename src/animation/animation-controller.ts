import { Events } from '../events';
import { AnimTrack } from '../anim-track';
import { TrackId, TrackData } from './animation-data';
import { CameraAnimTrack } from './camera-track';
import { AnimationTrackBase } from './animation-track-base';

/**
 * Animation controller manages all animation tracks for the project.
 * It creates, stores, and provides access to each track type.
 * Each track manages its own keyframes and interpolation.
 */
class AnimationController {
    private events: Events;
    private _tracks: Map<string, AnimTrack> = new Map();
    private _activeTrackId: string | null = null;

    constructor(events: Events) {
        this.events = events;
    }

    /** Ensure all track types are created */
    initialize(): void {
        this._tracks.set(TrackId.Camera, new CameraAnimTrack(this.events));

        // Default active track is camera (backward compat)
        this._activeTrackId = TrackId.Camera;
    }

    /** Get all track IDs */
    get trackIds(): string[] {
        return Array.from(this._tracks.keys());
    }

    /** Get a specific track by ID */
    getTrack(trackId: string): AnimTrack | undefined {
        return this._tracks.get(trackId);
    }

    /** Get the currently active track */
    get activeTrack(): AnimTrack | null {
        return this._activeTrackId ? (this._tracks.get(this._activeTrackId) ?? null) : null;
    }

    /** Get the active track ID */
    get activeTrackId(): string | null {
        return this._activeTrackId;
    }

    /** Set the active track by ID */
    setActiveTrack(trackId: string): void {
        if (this._tracks.has(trackId)) {
            this._activeTrackId = trackId;
            this.events.fire('track.activeChanged', trackId);
        }
    }

    /** Get all keyframe frames across all tracks (for timeline display) */
    getAllKeys(): Record<string, readonly number[]> {
        const result: Record<string, readonly number[]> = {};
        for (const [id, track] of this._tracks) {
            result[id] = track.keys;
        }
        return result;
    }

    /** Get user-visible keyframe frames (excludes control points) */
    getAllUserKeys(): Record<string, readonly number[]> {
        const result: Record<string, readonly number[]> = {};
        for (const [id, track] of this._tracks) {
            result[id] = track.userKeys;
        }
        return result;
    }

    /** Check if any track has keyframes */
    get hasKeys(): boolean {
        for (const track of this._tracks.values()) {
            if (track.keys.length > 0) return true;
        }
        return false;
    }

    /** Clear all tracks */
    clearAll(): void {
        for (const track of this._tracks.values()) {
            track.clear();
        }
    }

    /** Serialize all tracks */
    serialize(): Record<string, TrackData> {
        const result: Record<string, TrackData> = {};
        for (const [id, track] of this._tracks) {
            if (track instanceof AnimationTrackBase) {
                const data = track.serialize();
                if (data.keys.length > 0) {
                    result[id] = data;
                }
            }
        }
        return result;
    }

    /** Deserialize tracks */
    deserialize(data: Record<string, TrackData>): void {
        if (!data) return;
        for (const [id, trackData] of Object.entries(data)) {
            const track = this._tracks.get(id);
            if (track instanceof AnimationTrackBase && trackData.keys) {
                track.loadKeys(trackData.keys);
            }
        }
    }
}

const registerAnimationControllerEvents = (events: Events) => {
    const controller = new AnimationController(events);

    // Initialize tracks
    controller.initialize();

    // Expose controller
    events.function('animation.controller', () => controller);

    // Get active track (backward compat with old track-manager API)
    events.function('track.active', () => controller.activeTrack);

    // Get all track keys
    events.function('track.allKeys', () => controller.getAllKeys());
    events.function('track.allUserKeys', () => controller.getAllUserKeys());

    // Get specific track
    events.function('track.get', (trackId: string) => controller.getTrack(trackId));

    // Set active track
    events.on('track.setActive', (trackId: string) => {
        controller.setActiveTrack(trackId);
    });

    // Get track IDs
    events.function('track.ids', () => controller.trackIds);

    // Serialization
    events.function('docSerialize.tracks', () => controller.serialize());

    events.function('docDeserialize.tracks', (data: Record<string, TrackData>) => {
        controller.deserialize(data);
    });

    // Listen for scene clear
    events.on('scene.clear', () => {
        controller.clearAll();
    });
};

export { AnimationController, registerAnimationControllerEvents };
