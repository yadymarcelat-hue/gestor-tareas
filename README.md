# Proyectos Ingenio SAS

Gestor de proyectos y tareas con inicio de sesión propio. Las personas entran con correo y contraseña; solo pueden entrar quienes la administradora invite.

- **Frontend:** la app (`public/app.html`) más las páginas de ingreso (`/login`) y de crear contraseña (`/aceptar`).
- **Backend:** Next.js en Vercel, solo para dos rutas: `/api/config` y `/api/invite`.
- **Base de datos, login y archivos:** Supabase.

## Cómo funciona el acceso

1. La primera cuenta que se crea queda como **administradora**.
2. En **Equipo**, la administradora escribe correo, nombre, cargo y proyectos, y pulsa **Crear invitación**. La app genera un enlace.
3. La administradora le manda ese enlace a la persona por WhatsApp o correo. Vence en 24 horas.
4. La persona abre el enlace, pone su nombre y su contraseña, y entra.
5. Desde ahí entra en `/login` con su correo y contraseña. Si la olvida, usa **Olvidé mi contraseña**.
6. Si el enlace vence, la administradora pulsa **Enlace** junto a la persona en Equipo y genera uno nuevo.
7. Si la administradora quita a alguien del equipo, esa persona pierde el acceso de inmediato.

Permisos, aplicados en la base de datos:

| Qué | Quién puede cambiarlo |
|---|---|
| Proyectos, hitos, equipo | Solo la administradora |
| Tareas, subtareas, comentarios, archivos | Cualquier miembro |
| Ver un proyecto | Miembros agregados a ese proyecto (la administradora ve todos) |

## Puesta en marcha (unos 20 minutos)

### 1. Crear el proyecto en Supabase
1. Entra a [supabase.com](https://supabase.com) y crea un proyecto nuevo (el plan gratis sirve).
2. Ve a **SQL Editor**, pega todo el archivo `supabase/1-esquema.sql` y pulsa **Run**.

### 2. Configurar el inicio de sesión
En **Authentication > URL Configuration**:
- **Site URL:** la dirección de tu app en Vercel, por ejemplo `https://proyectos-ingenio.vercel.app`. Puedes ponerla después del paso 5.
- **Redirect URLs:** agrega `https://TU-DOMINIO/aceptar`. Mientras pruebas en tu computador, agrega también `http://localhost:3000/aceptar`.

En **Authentication > Providers > Email**, deja Email activado.

En **Authentication > Sign In / Providers**, desactiva **Allow new users to sign up**. Así nadie puede crearse una cuenta sin invitación. Las invitaciones siguen funcionando.

### 3. Crear tu usuario de administradora
En **Authentication > Users > Add user > Create new user**:
- Correo: `marcelatarazona@squads.ventures`
- Contraseña: la que quieras
- Marca **Auto Confirm User**

Por ser la primera cuenta, queda como administradora.

### 4. Pasar los datos que tenías
En **SQL Editor**, pega `supabase/2-migracion-datos.sql` y pulsa **Run**. Copia los proyectos Quicktrack y Solucionsoft, sus 4 hitos y sus 8 tareas, y los deja a tu nombre.

### 5. Publicar en Vercel
1. Sube esta carpeta a un repositorio de GitHub. Sin `node_modules` ni `.next`; el `.gitignore` ya los excluye.
2. En [vercel.com](https://vercel.com) elige **Add New > Project** e importa el repositorio. Vercel detecta Next.js solo.
3. En **Settings > Environment Variables** agrega las de `.env.example`:
   - `NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_ANON_KEY`: en Supabase, **Project Settings > API**.
   - `SUPABASE_SERVICE_ROLE_KEY`: en el mismo lugar, la llave **service_role**. Es secreta: solo va en Vercel, nunca en el código.
   - `APP_URL` (opcional): la dirección pública de la app.

   Si conectas Supabase con la integración de Vercel (**Storage > Supabase**), las tres primeras se crean solas.
4. Pulsa **Deploy**. Cuando termine, vuelve al paso 2 y pon la dirección real en Site URL y en Redirect URLs.

Para abrirlo en **v0**: importa el mismo repositorio de GitHub desde v0. Las variables de entorno se configuran igual.

### 6. Probar
1. Entra a `https://TU-DOMINIO/login` con tu correo y contraseña.
2. Ve a **Equipo**, invita a alguien y abre el enlace en una ventana de incógnito para ver lo que verá esa persona.

## Correos de "Olvidé mi contraseña"
Supabase los manda con su servidor de correo de prueba, que solo envía unos pocos por hora. Si el equipo crece, configura un servidor propio en **Authentication > Emails > SMTP Settings**, por ejemplo Resend o el correo de Google Workspace. Las invitaciones no dependen del correo: son enlaces que copias y envías tú.

## Probar en tu computador
```bash
cp .env.example .env.local   # y llena los valores
npm install
npm run dev                  # http://localhost:3000
```

## Archivos
| Archivo | Qué es |
|---|---|
| `public/app.html` | La aplicación: tablero, cronograma, hitos, equipo, proyectos |
| `public/shim.js` | Conecta la app con Supabase (datos en vivo, sesión, archivos) |
| `public/login.html`, `public/aceptar.html`, `public/auth.css` | Ingreso y creación de contraseña |
| `app/api/config/route.js` | Entrega la URL y la llave pública de Supabase al navegador |
| `app/api/invite/route.js` | Crea invitaciones; solo responde a la administradora |
| `supabase/1-esquema.sql` | Tablas, permisos, archivos y cambios en vivo |
| `supabase/2-migracion-datos.sql` | Tus datos actuales |

## Notas
- Los archivos adjuntos van al bucket `files` de Supabase. Se admite cualquier tipo, hasta 50 MB. Cada archivo se abre con un enlace largo imposible de adivinar, pero quien tenga ese enlace puede abrirlo.
- Los archivos que se habían subido en la versión de claude.ai no se migran, solo los enlaces. Esa versión no tenía archivos subidos.
