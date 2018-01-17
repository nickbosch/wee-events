import { CollectionReference, DocumentSnapshot, DocumentReference } from "@google-cloud/firestore";
import { Observable, Subscriber } from "rxjs";

import {
  SourceEvent,
  PublishedEvent,
  AggregateId,
  EventStore,
  EventStreamOptions,
  EventSnapshotOptions,
  stampEvent as toPublished,
  eventId,
} from "@weegigs/events-core";

export interface FirestoreStreamOptions extends EventStreamOptions {
  reconnect?: boolean;
}

export class FirestoreEventStore implements EventStore {
  constructor(private all: CollectionReference) {}

  private get events() {
    return this.all.orderBy("__publicationMetadata.id");
  }

  async publish(events: SourceEvent | SourceEvent[]): Promise<PublishedEvent[]> {
    const published = toPublished(events);
    const batch = this.all.firestore.batch();
    const normalized = await Promise.all(
      published.map(async event => {
        batch.create(this.documentKey(event), event);
        return event;
      })
    );

    await batch.commit();

    return normalized;
  }

  stream<E extends SourceEvent = any>(options: FirestoreStreamOptions = {}): Observable<PublishedEvent<E>> {
    const { after, reconnect } = { reconnect: true, ...options } as FirestoreStreamOptions;

    let position = after;
    const streamStartingAfter: (startAfter?: string) => Observable<PublishedEvent<E>> = (startAfter?: string) =>
      Observable.create((subscriber: Subscriber<PublishedEvent<E>>) => {
        let query = this.events;
        if (startAfter) {
          query = query.startAfter(startAfter);
        }

        const subscription = query.onSnapshot(
          snapshot => {
            snapshot.docChanges
              .filter(change => change.type === "added")
              .map(change => asEvent(change.doc))
              .forEach(event => {
                subscriber.next(event);
                position = eventId(event);
              });
          },
          error => subscriber.error(error)
        );

        return subscription;
      });

    return streamStartingAfter(position).catch(error => {
      if (reconnect) {
        console.log(`[WARN] FirestoreStream: Reconnecting after connection failure: ${error.message}`);
        return Observable.of(position)
          .delay(100)
          .flatMap(streamStartingAfter);
      } else {
        throw error;
      }
    });
  }

  async snapshot(
    aggregateId: AggregateId,
    options?: EventSnapshotOptions | undefined
  ): Promise<PublishedEvent[]> {
    const query = this.all
      .orderBy("__publicationMetadata.id")
      .where("aggregateId.id", "==", aggregateId.id)
      .where("aggregateId.type", "==", aggregateId.type);

    const snapshot = await query.get();

    return events(snapshot.docs);
  }

  private documentKey(event: PublishedEvent): DocumentReference {
    return this.all.doc(eventId(event));
  }
}

function events(docs: DocumentSnapshot[]): PublishedEvent<any>[] {
  return docs.map(asEvent);
}

function asEvent<E extends SourceEvent = any>(doc: DocumentSnapshot): PublishedEvent<E> {
  return doc.data() as PublishedEvent<E>;
}
