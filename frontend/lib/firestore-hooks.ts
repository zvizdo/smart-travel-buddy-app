"use client";

import { useEffect, useState } from "react";
import {
  collection,
  doc,
  onSnapshot,
  query,
  type DocumentData,
} from "firebase/firestore";
import { getFirestore } from "@/lib/firebase";

interface UseDocResult<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
}

interface UseCollectionResult<T> {
  data: T[];
  loading: boolean;
  error: Error | null;
}

export function useTrip(tripId: string | null): UseDocResult<DocumentData> {
  const [data, setData] = useState<DocumentData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!tripId) {
      setData(null);
      setLoading(false);
      return;
    }

    const db = getFirestore();
    const unsub = onSnapshot(
      doc(db, "trips", tripId),
      (snapshot) => {
        setData(snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null);
        setLoading(false);
      },
      (err) => {
        setError(err);
        setLoading(false);
      },
    );
    return unsub;
  }, [tripId]);

  return { data, loading, error };
}

export function useTripPlans(
  tripId: string | null,
): UseCollectionResult<DocumentData> {
  const [data, setData] = useState<DocumentData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!tripId) {
      setData([]);
      setLoading(false);
      return;
    }

    const db = getFirestore();
    const q = query(collection(db, `trips/${tripId}/plans`));
    const unsub = onSnapshot(
      q,
      (snapshot) => {
        const plans = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
        setData(plans);
        setLoading(false);
      },
      (err) => {
        setError(err);
        setLoading(false);
      },
    );
    return unsub;
  }, [tripId]);

  return { data, loading, error };
}

export function useTripNodes(
  tripId: string | null,
  planId: string | null,
): UseCollectionResult<DocumentData> {
  const [data, setData] = useState<DocumentData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!tripId || !planId) {
      setData([]);
      setLoading(false);
      return;
    }

    const db = getFirestore();
    const q = query(collection(db, `trips/${tripId}/plans/${planId}/nodes`));
    const unsub = onSnapshot(
      q,
      (snapshot) => {
        const nodes = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
        setData(nodes);
        setLoading(false);
      },
      (err) => {
        setError(err);
        setLoading(false);
      },
    );
    return unsub;
  }, [tripId, planId]);

  return { data, loading, error };
}

export function useTripEdges(
  tripId: string | null,
  planId: string | null,
): UseCollectionResult<DocumentData> {
  const [data, setData] = useState<DocumentData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!tripId || !planId) {
      setData([]);
      setLoading(false);
      return;
    }

    const db = getFirestore();
    const q = query(collection(db, `trips/${tripId}/plans/${planId}/edges`));
    const unsub = onSnapshot(
      q,
      (snapshot) => {
        const edges = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
        setData(edges);
        setLoading(false);
      },
      (err) => {
        setError(err);
        setLoading(false);
      },
    );
    return unsub;
  }, [tripId, planId]);

  return { data, loading, error };
}

export function usePulseLocations(
  tripId: string | null,
): UseCollectionResult<DocumentData> {
  const [data, setData] = useState<DocumentData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!tripId) {
      setData([]);
      setLoading(false);
      return;
    }

    const db = getFirestore();
    const q = query(collection(db, `trips/${tripId}/locations`));
    const unsub = onSnapshot(
      q,
      (snapshot) => {
        const locations = snapshot.docs.map((d) => ({
          id: d.id,
          ...d.data(),
        }));
        setData(locations);
        setLoading(false);
      },
      (err) => {
        setError(err);
        setLoading(false);
      },
    );
    return unsub;
  }, [tripId]);

  return { data, loading, error };
}

export function useNodeActions(
  tripId: string | null,
  planId: string | null,
  nodeId: string | null,
): UseCollectionResult<DocumentData> {
  const [data, setData] = useState<DocumentData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!tripId || !planId || !nodeId) {
      setData([]);
      setLoading(false);
      return;
    }

    const db = getFirestore();
    const q = query(
      collection(
        db,
        `trips/${tripId}/plans/${planId}/nodes/${nodeId}/actions`,
      ),
    );
    const unsub = onSnapshot(
      q,
      (snapshot) => {
        const actions = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
        setData(actions);
        setLoading(false);
      },
      (err) => {
        setError(err);
        setLoading(false);
      },
    );
    return unsub;
  }, [tripId, planId, nodeId]);

  return { data, loading, error };
}

export function useTripNotifications(
  tripId: string | null,
  userId: string | null,
): UseCollectionResult<DocumentData> {
  const [data, setData] = useState<DocumentData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!tripId || !userId) {
      setData([]);
      setLoading(false);
      return;
    }

    const db = getFirestore();
    const q = query(collection(db, `trips/${tripId}/notifications`));
    const unsub = onSnapshot(
      q,
      (snapshot) => {
        const notifs = snapshot.docs
          .map((d) => ({ id: d.id, ...d.data() } as DocumentData))
          .filter((n) => {
            const targets = n["target_user_ids"] as string[] | undefined;
            return targets?.includes(userId);
          });
        setData(notifs);
        setLoading(false);
      },
      (err) => {
        setError(err);
        setLoading(false);
      },
    );
    return unsub;
  }, [tripId, userId]);

  return { data, loading, error };
}
