/*
Copyright 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/
import type {
    Stores,
    RoomListStore as IRoomListStore,
    MultiRoomViewStore as IMultiRoomViewStore,
} from "@element-hq/element-web-module-api";
import type { Room } from "matrix-js-sdk/src/matrix";
import RoomListStoreV3, { LISTS_LOADED_EVENT } from "../stores/room-list-v3/RoomListStoreV3";
import { SdkContextClass } from "../contexts/SDKContext";

class RoomListStoreApi implements IRoomListStore {
    public getRooms(): Room[] {
        return RoomListStoreV3.instance.getSortedRooms();
    }

    public async waitForRoomListLoad(): Promise<void> {
        // Check if RLS is already loaded
        if (!RoomListStoreV3.instance.isLoadingRooms) return;

        // Return a promise that resolves when RLS has loaded
        let resolve: () => void;
        const promise: Promise<void> = new Promise((_resolve) => {
            resolve = _resolve;
        });
        RoomListStoreV3.instance.once(LISTS_LOADED_EVENT, () => {
            resolve();
        });
        return promise;
    }
}

class MultiRoomViewStore implements IMultiRoomViewStore {
    public getRoomViewStoreForRoom(roomId: string): unknown {
        return SdkContextClass.instance.multiRoomViewStore.getRoomViewStoreForRoom(roomId);
    }

    public removeRoomViewStore(roomId: string): void {
        SdkContextClass.instance.multiRoomViewStore.removeRoomViewStore(roomId);
    }
}

export class StoreApi implements Stores {
    private roomListStore?: IRoomListStore;
    private multiRoomViewStore?: IMultiRoomViewStore;

    public getRoomListStore(): IRoomListStore {
        if (!this.roomListStore) {
            this.roomListStore = new RoomListStoreApi();
        }
        return this.roomListStore;
    }

    public getMultiRoomViewStore(): IMultiRoomViewStore {
        if (!this.multiRoomViewStore) {
            this.multiRoomViewStore = new MultiRoomViewStore();
        }
        return this.multiRoomViewStore;
    }
}
