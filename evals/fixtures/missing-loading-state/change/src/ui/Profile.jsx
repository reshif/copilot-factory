import { useEffect, useState } from 'react';

export function Profile() {
  const [user, setUser] = useState(null);
  useEffect(() => {
    fetch('/api/me').then((r) => r.json()).then(setUser);
  }, []);
  return (
    <section>
      <h2>{user.name}</h2>
      <p>{user.email}</p>
    </section>
  );
}
