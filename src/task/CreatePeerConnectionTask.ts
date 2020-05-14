// Copyright 2019-2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import AudioVideoControllerState from '../audiovideocontroller/AudioVideoControllerState';
import BackoffPolicy from '../backoff/Backoff';
import FullJitterBackoff from '../backoff/FullJitterBackoff';
import RemovableObserver from '../removableobserver/RemovableObserver';
import TimeoutScheduler from '../scheduler/TimeoutScheduler';
import VideoTile from '../videotile/VideoTile';
import VideoTileState from '../videotile/VideoTileState';
import BaseTask from './BaseTask';
/*
 * [[CreatePeerConnectionTask]] sets up the peer connection object.
 */
export default class CreatePeerConnectionTask extends BaseTask implements RemovableObserver {
  protected taskName = 'CreatePeerConnectionTask';

  private removeTrackAddedEventListener: (() => void) | null = null;
  private removeTrackRemovedEventListeners: { [trackId: string]: () => void } = {};
  private presenceHandlerSet = new Set<
    (attendeeId: string, present: boolean, externalUserId?: string | null) => void
  >();

  private readonly trackEvents: string[] = [
    'ended',
    'mute',
    'unmute',
    'isolationchange',
    'overconstrained',
  ];
  private removeVideoTrackEventListeners: { [trackId: string]: (() => void)[] } = {};
  private trackCapability: MediaTrackCapabilities | MediaTrackSettings;
  private backoffPolicy: BackoffPolicy;
  private backoffTimer: TimeoutScheduler | null = null;
  private isContentWidthHeightSet: boolean = false;
  static readonly REMOVE_HANDLER_INTERVAL_MS: number = 10000;

  private static readonly RECONNECT_FIXED_WAIT_MS = 10;
  private static readonly RECONNECT_SHORT_BACKOFF_MS = 1 * 2000;
  private static readonly RECONNECT_LONG_BACKOFF_MS = 5 * 1000;

  constructor(
    private context: AudioVideoControllerState,
    private externalUserIdTimeoutMs: number = CreatePeerConnectionTask.REMOVE_HANDLER_INTERVAL_MS
  ) {
    super(context.logger);
  }

  removeObserver(): void {
    this.removeTrackAddedEventListener && this.removeTrackAddedEventListener();
    for (const trackId in this.removeTrackRemovedEventListeners) {
      this.removeTrackRemovedEventListeners[trackId]();
    }
    for (const handler of this.presenceHandlerSet) {
      this.context.realtimeController.realtimeUnsubscribeToAttendeeIdPresence(handler);
      this.presenceHandlerSet.delete(handler);
    }
  }

  private addPeerConnectionEventLogger(): void {
    const peer = this.context.peer;
    peer.addEventListener('connectionstatechange', () => {
      this.context.logger.info(`peer connection state changed: ${peer.connectionState}`);
    });
    peer.addEventListener('negotiationneeded', () => {
      this.context.logger.info('peer connection negotiation is needed');
    });
    peer.addEventListener('icegatheringstatechange', () => {
      this.context.logger.info(
        `peer connection ice gathering state changed: ${peer.iceGatheringState}`
      );
    });
    peer.addEventListener('icecandidate', (event: RTCPeerConnectionIceEvent) => {
      this.context.logger.info(
        `peer connection ice candidate: ${event.candidate ? event.candidate.candidate : '(null)'}`
      );
    });
    peer.addEventListener('iceconnectionstatechange', () => {
      this.context.logger.info(
        `peer connection ice connection state changed: ${peer.iceConnectionState}`
      );
    });
  }

  async run(): Promise<void> {
    this.context.removableObservers.push(this);

    const configuration: RTCConfiguration = this.context.turnCredentials
      ? {
          iceServers: [
            {
              urls: this.context.turnCredentials.uris,
              username: this.context.turnCredentials.username,
              credential: this.context.turnCredentials.password,
              credentialType: 'password',
            },
          ],
          iceTransportPolicy: 'relay',
        }
      : {};
    configuration.bundlePolicy = this.context.browserBehavior.requiresBundlePolicy();
    // @ts-ignore
    configuration.sdpSemantics = this.context.browserBehavior.requiresUnifiedPlan()
      ? 'unified-plan'
      : 'plan-b';
    // @ts-ignore
    this.logger.info(`SDP semantics are ${configuration.sdpSemantics}`);

    if (this.context.peer) {
      this.context.logger.info('reusing peer connection');
    } else {
      this.context.logger.info('creating new peer connection');
      this.context.peer = new RTCPeerConnection(configuration);
      this.addPeerConnectionEventLogger();
    }

    this.removeTrackAddedEventListener = () => {
      if (this.context.peer) {
        this.context.peer.removeEventListener('track', this.trackAddedHandler);
      }
      this.removeTrackAddedEventListener = null;
    };
    this.context.peer.addEventListener('track', this.trackAddedHandler);
  }

  private trackAddedHandler = (event: RTCTrackEvent) => {
    const track: MediaStreamTrack = event.track;
    this.context.logger.info(
      `received track event: kind=${track.kind} id=${track.id} label=${track.label}`
    );

    const stream: MediaStream = event.streams[0];
    if (track.kind === 'audio') {
      this.context.audioMixController.bindAudioStream(stream);
    } else if (track.kind === 'video' && !this.trackIsVideoInput(track)) {
      this.addRemoteVideoTrack(track, stream);
    }
  };

  private trackIsVideoInput(track: MediaStreamTrack): boolean {
    if (this.context.transceiverController.useTransceivers()) {
      this.logger.debug(() => {
        return `getting video track type (unified-plan)`;
      });
      return this.context.transceiverController.trackIsVideoInput(track);
    }
    this.logger.debug(() => {
      return `getting video track type (plan-b)`;
    });
    if (this.context.activeVideoInput) {
      const tracks = this.context.activeVideoInput.getVideoTracks();
      if (tracks && tracks.length > 0 && tracks[0].id === track.id) {
        return true;
      }
    }
    return false;
  }

  private bindExternalIdToRemoteTile(
    tile: VideoTile,
    attendeeId: string,
    stream: MediaStream,
    width: number,
    height: number,
    streamId: number
  ): void {
    const timeoutScheduler = new TimeoutScheduler(this.externalUserIdTimeoutMs);
    const handler = (presentAttendeeId: string, present: boolean, externalUserId: string): void => {
      if (attendeeId === presentAttendeeId && present && externalUserId !== null) {
        tile.bindVideoStream(attendeeId, false, stream, width, height, streamId, externalUserId);
        this.context.realtimeController.realtimeUnsubscribeToAttendeeIdPresence(handler);
        this.presenceHandlerSet.delete(handler);
        timeoutScheduler.stop();
      }
    };
    this.context.realtimeController.realtimeSubscribeToAttendeeIdPresence(handler);
    this.presenceHandlerSet.add(handler);
    timeoutScheduler.start(() => {
      this.context.realtimeController.realtimeUnsubscribeToAttendeeIdPresence(handler);
      this.presenceHandlerSet.delete(handler);
    });
  }

  private addRemoteVideoTrack(track: MediaStreamTrack, stream: MediaStream): void {
    let trackId = stream.id;
    if (!this.context.browserBehavior.requiresUnifiedPlan()) {
      stream = new MediaStream([track]);
      trackId = track.id;
    }
    const attendeeId = this.context.videoStreamIndex.attendeeIdForTrack(trackId);

    // TODO: in case a previous tile with the same attendee id hasn't been cleaned up
    // we do it here to avoid showing a duplicate tile. We should try to understand
    // why this can happen, so adding a log statement to track this and learn more.
    const tilesRemoved = this.context.videoTileController.removeVideoTilesByAttendeeId(attendeeId);
    if (tilesRemoved.length > 0) {
      this.logger.info(
        `removing existing tiles ${tilesRemoved} with same attendee id ${attendeeId}`
      );
    }

    const tile = this.context.videoTileController.addVideoTile();
    let streamId: number | null = this.context.videoStreamIndex.streamIdForTrack(trackId);
    if (typeof streamId === 'undefined') {
      this.logger.warn(`stream not found for tile=${tile.id()} track=${trackId}`);
      streamId = null;
    }

    for (let i = 0; i < this.trackEvents.length; i++) {
      const trackEvent: string = this.trackEvents[i];
      const videoTracks = stream.getVideoTracks();
      if (videoTracks && videoTracks.length) {
        const videoTrack: MediaStreamTrack = videoTracks[0];
        console.log(
          `&&&& received the ${trackEvent} event for tile=${tile.id()} id=${
            track.id
          } streamId=${streamId}`
        );
        const callback: EventListenerOrEventListenerObject = (): void => {
          this.context.logger.info(
            `received the ${trackEvent} event for tile=${tile.id()} id=${
              track.id
            } streamId=${streamId}`
          );
        };
        videoTrack.addEventListener(trackEvent, callback);
        if (!this.removeVideoTrackEventListeners[track.id]) {
          this.removeVideoTrackEventListeners[track.id] = [];
        }
        this.removeVideoTrackEventListeners[track.id].push(() => {
          videoTrack.removeEventListener(trackEvent, callback);
        });
      }
    }
    this.backoffPolicy = new FullJitterBackoff(
      CreatePeerConnectionTask.RECONNECT_FIXED_WAIT_MS,
      CreatePeerConnectionTask.RECONNECT_SHORT_BACKOFF_MS,
      CreatePeerConnectionTask.RECONNECT_LONG_BACKOFF_MS
    );
    console.log('&&&& 000000 ' + 'before while');
    //while(true){
    console.log('&&&& 000000 ' + 'no call');
    this.isContentWidthHeightSet = false;
    //this.waitingToBindTile = this.bindTile(track, tile, this.trackCapability, attendeeId, stream, streamId, trackId);
    this.bindTile(track, tile, attendeeId, stream, streamId, trackId);
    //console.log("&&&& 000000 " + this.waitingToBindTile);
    //if (this.waitingToBindTile === false)
    //  break;
    //}
    let endEvent = 'removetrack';
    let target: MediaStream = stream;
    if (!this.context.browserBehavior.requiresUnifiedPlan()) {
      this.logger.debug(() => {
        return 'updating end event and target track (plan-b)';
      });
      endEvent = 'ended';
      // @ts-ignore
      target = track;
    }

    const trackRemovedHandler = (): void => this.removeRemoteVideoTrack(track, tile.state());
    this.removeTrackRemovedEventListeners[track.id] = () => {
      target.removeEventListener(endEvent, trackRemovedHandler);
      delete this.removeTrackRemovedEventListeners[track.id];
    };
    target.addEventListener(endEvent, trackRemovedHandler);
  }

  bindTile(
    track: MediaStreamTrack,
    tile: VideoTile,
    attendeeId: string,
    stream: MediaStream,
    streamId: number,
    trackId: string
  ): void {
    this.trackCapability = null;
    this.retryWithBackoff(
      async () => {
        if (track.getSettings) {
          this.trackCapability = track.getSettings();
          console.log(this.trackCapability + '&&&&& 888888 getSettings()');
        } else {
          this.trackCapability = track.getCapabilities();
          console.log(this.trackCapability + '&&&&& 9999999 getSettings()');
        }
        this.isContentWidthHeightSet = false;
        console.log(this.isCapabilitySet() + ' &&&&& 0000111111 ' + this.trackCapability);
        if (this.isCapabilitySet()) {
          const externalUserId = this.context.realtimeController.realtimeExternalUserIdFromAttendeeId(
            attendeeId
          );
          const width = this.trackCapability.width as number;
          const height = this.trackCapability.height as number;
          console.log(width + ' &&&&& 22222 ' + height);
          this.isContentWidthHeightSet = true;
          if (externalUserId) {
            tile.bindVideoStream(
              attendeeId,
              false,
              stream,
              width,
              height,
              streamId,
              externalUserId
            );
          } else {
            this.bindExternalIdToRemoteTile(tile, attendeeId, stream, width, height, streamId);
          }
          //this.backoffTimer.stop();
          this.logger.info(
            `video track added, created tile=${tile.id()} track=${trackId} streamId=${streamId}`
          );
        }
      }
    );
  }

  isCapabilitySet(): boolean {
    console.log(' &&&&& 333333 ' + this.trackCapability);
    if (this.trackCapability !== null) {
      console.log(' &&&&& 444444 ' + this.trackCapability);
      //if (typeof this.trackCapability.width === 'number' && typeof this.trackCapability.height === 'number') {
      if (this.trackCapability.width !== null && typeof this.trackCapability.height !== null) {
        console.log(' &&&&& 5555555 ' + this.trackCapability.width);
        return true;
      } else {
        console.log(' &&&&& 66666 11111' + this.trackCapability.width);
        this.isContentWidthHeightSet = false;
        return false;
      }
    }
    console.log(' &&&&& 66666 222222' + this.trackCapability.width);
    this.isContentWidthHeightSet = false;
    return false;
  }

  retryWithBackoff(retryFunc: () => void): boolean {
    const willRetry = !this.isContentWidthHeightSet;
    console.log(this.isContentWidthHeightSet + '&&&&&& 11111222222 ');
    if (willRetry) {
      console.log(
        this.isContentWidthHeightSet + '&&&&&& 11111 ' + this.backoffPolicy.nextBackoffAmountMs()
      );
      this.backoffTimer = new TimeoutScheduler(this.backoffPolicy.nextBackoffAmountMs());
      this.backoffTimer.start(() => {
        console.log(this.isContentWidthHeightSet + '&&&&&& 77777777 ');
        retryFunc();
      });
    }
    return willRetry;
  }

  private removeRemoteVideoTrack(track: MediaStreamTrack, tileState: VideoTileState): void {
    this.removeTrackRemovedEventListeners[track.id]();

    for (const removeVideoTrackEventListener of this.removeVideoTrackEventListeners[track.id]) {
      removeVideoTrackEventListener();
    }
    delete this.removeVideoTrackEventListeners[track.id];

    this.logger.info(
      `video track ended, removing tile=${tileState.tileId} id=${track.id} stream=${tileState.streamId}`
    );

    if (tileState.streamId) {
      this.context.videosPaused.remove(tileState.streamId);
    } else {
      this.logger.warn(`no stream found for tile=${tileState.tileId}`);
    }
    this.context.videoTileController.removeVideoTile(tileState.tileId);
  }
}
