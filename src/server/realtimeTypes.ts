import type { WebSocket } from 'ws';
import type { AuthoritativeBoardState } from '../gameLogic/index.ts';
import type { SettledUserNotification } from '../games/shisanshui/serverBookingService.ts';

export type { AuthoritativeBoardState };

export const SETTLEMENT_TIMEOUT_MS = 60000;

export interface ScenePlayer {
  id: string;
  name: string;
  avatar: string;
  rating: number;
  coins: number;
  seat: number;
  isSimulated?: boolean;
  isReady?: boolean;
  socketId?: string;
  isDisconnected?: boolean;
  isAutoManaged?: boolean;
  originalId?: string;
  originalName?: string;
}

export interface SceneWaitingRoom {
  id: string;
  gameType: string;
  sceneMode: string;
  sceneName: string;
  maxPlayers: number;
  players: ScenePlayer[];
  status: 'waiting' | 'starting' | 'playing' | 'finished';
  createdAt: number;
  lastTurnTs?: number;
  deal?: any;
  roundIndex?: number;
}

export interface ActiveChallengeRecord {
  id: string;
  senderId: string;
  senderName: string;
  avatar: string;
  gameType: string;
  sceneMode: string;
  sceneName: string;
  text: string;
  status: 'open' | 'accepted' | 'overwritten' | 'transferred' | 'cancelled' | 'removed';
  acceptedBy?: { id: string; name: string };
  timestamp: string;
  createdAt: number;
}

export function isBotLikePlayer(p: any): boolean {
  if (!p) return false;
  return Boolean(
    p.isAi ||
      p.isSimulated ||
      p.isBot ||
      p.id?.startsWith?.('BOT-') ||
      p.id?.startsWith?.('sim-') ||
      p.id?.startsWith?.('P-sim-')
  );
}

export interface RealtimeHubContext {
  rooms: Map<string, any>;
  sceneWaitingRooms: Map<string, SceneWaitingRoom>;
  broadcast: (payload: unknown) => void;
  sendSanitizedToRoom: (
    room: { id: string; players?: any[] },
    buildPayloadForSeat: (seat: number, player: any) => unknown
  ) => void;
  settleRoomCoins: (
    room: any,
    coinsDeltaBySeat: number[],
    gameType: string,
    meta?: { ratingDeltaBySeat?: number[] }
  ) => void;
  resetSceneRoomReadyAndCleanDisconnected: (roomId: string) => void;
  emitBookingSettlementNotifications: (notifications: SettledUserNotification[]) => void;
}
