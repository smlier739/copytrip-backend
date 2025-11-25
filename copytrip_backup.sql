--
-- PostgreSQL database dump
--

\restrict susJj0oqsP4hdIQ0EB2AniwRXzv3wAeusUH8Mlvrwhs7toZMx8bbtOKf7eJLEy9

-- Dumped from database version 16.10
-- Dumped by pg_dump version 16.10

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: Day; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public."Day" (
    id text NOT NULL,
    "dayNumber" integer NOT NULL,
    date timestamp(3) without time zone,
    "templateId" text NOT NULL
);


ALTER TABLE public."Day" OWNER TO postgres;

--
-- Name: Stop; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public."Stop" (
    id text NOT NULL,
    name text NOT NULL,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    arrival text,
    departure text,
    notes text,
    "dayId" text NOT NULL
);


ALTER TABLE public."Stop" OWNER TO postgres;

--
-- Name: Template; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public."Template" (
    id text NOT NULL,
    title text NOT NULL,
    summary text,
    tags text NOT NULL,
    "coverImage" text,
    "ownerId" text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


ALTER TABLE public."Template" OWNER TO postgres;

--
-- Name: User; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public."User" (
    id text NOT NULL,
    email text NOT NULL,
    name text,
    image text,
    role text DEFAULT 'user'::text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);


ALTER TABLE public."User" OWNER TO postgres;

--
-- Name: _prisma_migrations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public._prisma_migrations (
    id character varying(36) NOT NULL,
    checksum character varying(64) NOT NULL,
    finished_at timestamp with time zone,
    migration_name character varying(255) NOT NULL,
    logs text,
    rolled_back_at timestamp with time zone,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_steps_count integer DEFAULT 0 NOT NULL
);


ALTER TABLE public._prisma_migrations OWNER TO postgres;

--
-- Data for Name: Day; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public."Day" (id, "dayNumber", date, "templateId") FROM stdin;
cmhv1vxly0007afe6p7dukt3k	1	\N	cmhv1sp7g0004afe6r69qk5c1
cmhv1vxm4000dafe6c8eg1ltn	2	\N	cmhv1sp7g0004afe6r69qk5c1
\.


--
-- Data for Name: Stop; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public."Stop" (id, name, lat, lng, arrival, departure, notes, "dayId") FROM stdin;
cmhv1vxm10009afe6k399mj4v	Nytt stopp	60	10	10:00	11:00	\N	cmhv1vxly0007afe6p7dukt3k
cmhv1vxm4000bafe6uynzrevx	Nytt stopp	60	10	10:00	11:00	\N	cmhv1vxly0007afe6p7dukt3k
cmhv1vxm5000fafe64l3a0bk8	Nytt stopp	60	10	10:00	11:00	\N	cmhv1vxm4000dafe6c8eg1ltn
cmhv1vxm6000hafe68cnspyhv	Nytt stopp	60	10	10:00	11:00	\N	cmhv1vxm4000dafe6c8eg1ltn
\.


--
-- Data for Name: Template; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public."Template" (id, title, summary, tags, "coverImage", "ownerId", "createdAt", "updatedAt") FROM stdin;
cmhv1sjtg0002afe6j0i3w7xr	Ny mal		admin	\N	cmhv1s5g20000afe67h5jv35l	2025-11-11 20:52:52.948	2025-11-11 20:52:52.948
cmhv1sp7g0004afe6r69qk5c1	Tur	Dette er en test.	admin	\N	cmhv1s5g20000afe67h5jv35l	2025-11-11 20:52:59.931	2025-11-11 20:54:42.933
cmhv1znkx0001aoalocgny4zf	Ny mal		admin	\N	cmhv1s5g20000afe67h5jv35l	2025-11-11 20:58:24.417	2025-11-11 20:58:24.417
cmhv1zs8h0003aoalnyfvce9c	Oalo - Bergen Roadtrip		admin	\N	cmhv1s5g20000afe67h5jv35l	2025-11-11 20:58:30.448	2025-11-11 20:59:09.934
\.


--
-- Data for Name: User; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public."User" (id, email, name, image, role, "createdAt", "updatedAt") FROM stdin;
cmhv1s5g20000afe67h5jv35l	demo@example.com	Admin	\N	admin	2025-11-11 20:52:34.323	2025-11-11 20:52:34.323
\.


--
-- Data for Name: _prisma_migrations; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public._prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count) FROM stdin;
acd55fc1-ad19-478f-9101-c4119b73a616	da3331644c2af71ce330f474c2f650f6a68d152514f50811506807354e357ed0	2025-11-11 20:52:18.942476+00	20251111205218_init	\N	\N	2025-11-11 20:52:18.929924+00	1
\.


--
-- Name: Day Day_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."Day"
    ADD CONSTRAINT "Day_pkey" PRIMARY KEY (id);


--
-- Name: Stop Stop_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."Stop"
    ADD CONSTRAINT "Stop_pkey" PRIMARY KEY (id);


--
-- Name: Template Template_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."Template"
    ADD CONSTRAINT "Template_pkey" PRIMARY KEY (id);


--
-- Name: User User_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."User"
    ADD CONSTRAINT "User_pkey" PRIMARY KEY (id);


--
-- Name: _prisma_migrations _prisma_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public._prisma_migrations
    ADD CONSTRAINT _prisma_migrations_pkey PRIMARY KEY (id);


--
-- Name: User_email_key; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX "User_email_key" ON public."User" USING btree (email);


--
-- Name: Day Day_templateId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."Day"
    ADD CONSTRAINT "Day_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES public."Template"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Stop Stop_dayId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."Stop"
    ADD CONSTRAINT "Stop_dayId_fkey" FOREIGN KEY ("dayId") REFERENCES public."Day"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Template Template_ownerId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public."Template"
    ADD CONSTRAINT "Template_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--

\unrestrict susJj0oqsP4hdIQ0EB2AniwRXzv3wAeusUH8Mlvrwhs7toZMx8bbtOKf7eJLEy9

