-- Igual que ejecutar_sql pero tolerante: cada sentencia corre en su propio bloque; si una falla, se anota y
-- las demás siguen. Lo usa el "espejo" que copia a Supabase cada escritura que se hace en Cloudflare D1.
create or replace function public.ejecutar_sql_espejo_argomedo(sentencias jsonb)
returns jsonb
language plpgsql
security definer
set search_path = argomedo455, public
as $$
declare
  s text;
  i int := 0;
  errores jsonb := '[]'::jsonb;
begin
  for s in select jsonb_array_elements_text(sentencias) loop
    i := i + 1;
    begin
      execute s;
    exception when others then
      errores := errores || jsonb_build_array(jsonb_build_object('i', i, 'error', sqlerrm, 'sql', left(s, 300)));
    end;
  end loop;
  return jsonb_build_object('ok', true, 'total', i, 'errores', errores);
end;
$$;
revoke all on function public.ejecutar_sql_espejo_argomedo(jsonb) from public, anon, authenticated;
grant execute on function public.ejecutar_sql_espejo_argomedo(jsonb) to service_role;
